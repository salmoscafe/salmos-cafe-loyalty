// ---------------------------------------------------------------
// loyverse-customers — Edge Function segura.
//
// El navegador NUNCA toca la API de Loyverse. Esta función es la
// única que habla con api.loyverse.com y la única que conoce
// LOYVERSE_ACCESS_TOKEN (variable de entorno del lado servidor,
// jamás VITE_*, jamás en el bundle).
//
// Seguridad:
//   * Requiere Authorization: Bearer <JWT del usuario>.
//   * Lee/escribe la fila `customers` SOLO del usuario autenticado
//     (RLS: auth.uid() = auth_user_id), usando el propio JWT.
//   * No expone el token de Loyverse ni detalles internos en las
//     respuestas. Los fallos devuelven códigos amigables.
//
// Despliegue: supabase functions deploy loyverse-customers
// Vars: SUPABASE_URL, SUPABASE_ANON_KEY, LOYVERSE_ACCESS_TOKEN
// ---------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { runLoyverseSync } from "../_shared/syncClaim.js";

const LOYVERSE_BASE = "https://api.loyverse.com/v1.0/customers";
const LOYVERSE_PAGE_LIMIT = 250;
const LOYVERSE_MAX_PHONE_PAGES = 15; // tope defensivo (≤ 3,750 clientes escaneados)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function safeDetail(value) {
  const text = String(value || "");
  return text.slice(0, 500);
}

// Transporte hacia la API de Loyverse (token SOLO aquí).
function createTransport(accessToken) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  async function request(url, init) {
    const res = await fetch(url, init ? { ...init, headers: { ...headers, ...(init.headers || {}) } } : { headers });
    if (!res.ok) {
      const error = new Error(`Loyverse request failed with ${res.status}`);
      error.status = res.status;
      error.body = await res.text();
      throw error;
    }
    return res.json();
  }

  return {
    async listByEmail(email) {
      // Filtro oficial de la API: ?email=... (limit 1 alcanza).
      const data = await request(`${LOYVERSE_BASE}?email=${encodeURIComponent(email)}&limit=1`);
      return data.customers || [];
    },
    async listByPhone(phone) {
      // La API NO filtra por phone_number → se pagina la lista y se filtra.
      const digits = String(phone).replace(/\D/g, "");
      const found = [];
      let cursor = null;
      for (let page = 0; page < LOYVERSE_MAX_PHONE_PAGES && found.length === 0; page++) {
        const url = `${LOYVERSE_BASE}?limit=${LOYVERSE_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const data = await request(url);
        for (const customer of data.customers || []) {
          const cDigits = String(customer.phone_number || "").replace(/\D/g, "");
          if (cDigits && cDigits === digits) found.push(customer);
        }
        cursor = data.cursor || null;
        if (!cursor) break;
      }
      return found;
    },
    async create(payload) {
      const data = await request(LOYVERSE_BASE, { method: "POST", body: JSON.stringify(payload) });
      return data;
    },
    async update(customerId, payload) {
      // PUT parcial: solo se envían los campos que Salmos rellena (nunca
      // total_* ni campos derivados del POS) — Loyverse conserva el resto.
      const data = await request(`${LOYVERSE_BASE}/${encodeURIComponent(customerId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      return data;
    },
  };
}

// Adaptador del claim hacia Supabase. `claim` = el UPDATE condicional
// atómico de la migración 0006: mientras otro claim esté vigente (no
// vencido), el WHERE no matchea y count llega 0 (perdedor). `release` =
// liberación con scope auth_user_id + token (nunca borra un claim ajeno).
function createClaimDb(supabase) {
  return {
    async claim({ authUserId, claim, claimAt, cutoffIso }) {
      const { data, error } = await supabase
        .from("customers")
        .update({ loyverse_sync_claim: claim, loyverse_sync_claim_at: claimAt })
        .eq("auth_user_id", authUserId)
        .or(`loyverse_sync_claim.is.null,loyverse_sync_claim_at.lt.${cutoffIso}`)
        .select("auth_user_id")
        .maybeSingle();
      if (error) throw error;
      return { count: data ? 1 : 0 };
    },
    async release({ authUserId, claim }) {
      const { error } = await supabase
        .from("customers")
        .update({ loyverse_sync_claim: null, loyverse_sync_claim_at: null })
        .eq("auth_user_id", authUserId)
        .eq("loyverse_sync_claim", claim);
      return { error };
    },
  };
}

async function logSyncEvent(supabase, { authUserId, traceId, eventType, detail }) {
  await supabase.from("customer_sync_events").insert({
    auth_user_id: authUserId,
    trace_id: traceId,
    event_type: eventType,
    detail: { ...detail, traceId },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const loyverseAccessToken = Deno.env.get("LOYVERSE_ACCESS_TOKEN") || "";

  if (!loyverseAccessToken) {
    return json({ ok: false, code: "srv_not_configured", retriable: true }, 503);
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return json({ ok: false, code: "unauthorized", retriable: false }, 401);

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user) return json({ ok: false, code: "unauthorized", retriable: false }, 401);

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, code: "invalid_body", retriable: false }, 400);
    }
    if (body.operation !== "link_or_create") {
      return json({ ok: false, code: "invalid_operation", retriable: false }, 400);
    }

    const traceId = crypto.randomUUID();

    // 1) Fila actual del cliente (idempotencia y defaults). El caso
    //    already_linked (ya vinculado + synced) se resuelve dentro de
    //    runLoyverseSync ANTES de tomar el claim: un perfil synced no
    //    toca la columna del claim ni llama a Loyverse.
    const { data: profile } = await supabase
      .from("customers")
      .select("*")
      .eq("auth_user_id", user.id)
      .maybeSingle();

    const name = body.name || profile?.name || user.user_metadata?.name || "";
    const email = body.email || profile?.email || null;
    const phone = body.phone || profile?.phone || user.phone || null;
    const customerCode = body.customerCode || profile?.customer_code || null;

    if (!name) return json({ ok: false, code: "missing_name", retriable: false }, 400);

    const transport = createTransport(loyverseAccessToken);

    try {
      const outcome = await runLoyverseSync({
        db: createClaimDb(supabase),
        transport,
        authUserId: user.id,
        profile,
        name,
        email,
        phone,
        customerCode,
      });

      if (outcome.status === "no_profile") {
        return json({ ok: false, code: "customer_setup_required", traceId, retriable: false }, 409);
      }
      if (outcome.status === "already_linked") {
        return json({ ok: true, status: "already_linked", loyverseCustomerId: outcome.loyverseCustomerId });
      }
      if (outcome.status === "busy") {
        // Otro sync en curso (claim vigente): retriable y SIN llamar a
        // Loyverse. El single-flight del frontend deduplica; este claim
        // es la barrera server-side entre pestañas/instancias.
        return json({ ok: false, code: "loyverse_sync_in_progress", traceId, retriable: true }, 409);
      }

      const result = outcome.result;

      if (result.status === "conflict") {
        await logSyncEvent(supabase, {
          authUserId: user.id,
          traceId,
          eventType: "loyverse_conflict",
          detail: result.audit || {},
        });
        await supabase
          .from("customers")
          .update({ loyverse_sync_status: "failed" })
          .eq("auth_user_id", user.id);
        // identity_conflict ⇄ email/teléfono distintos en el cliente ya
        // resuelto: la UI muestra cómo vincular/recuperar la cuenta.
        const code =
          result.audit?.code === "identity_conflict" ? "loyverse_identity_conflict" : "loyverse_customer_conflict";
        return json(
          { ok: false, code, traceId, retriable: false },
          409
        );
      }

      // El vínculo local es el objetivo: si no se graba, el perfil queda
      // sin `loyverse_customer_id` y un reintento re-entraría por
      // búsqueda (seguro) en el peor caso tras un fallo. En vez de
      // responder éxito con el id "perdido", se propaga como 502
      // retriable: el cliente mantiene `failed` y el reintento rebusca y
      // reusa el cliente remoto ya creado.
      const { error: linkError } = await supabase
        .from("customers")
        .update({
          loyverse_customer_id: result.loyverseCustomerId,
          loyverse_sync_status: "synced",
        })
        .eq("auth_user_id", user.id);
      if (linkError) throw linkError;

      await logSyncEvent(supabase, {
        authUserId: user.id,
        traceId,
        eventType:
          result.status === "created"
            ? "loyverse_created"
            : result.status === "updated"
              ? "loyverse_updated"
              : result.status === "already_linked"
                ? "loyverse_already_linked"
                : "loyverse_linked",
        detail: result.audit || {},
      });

      return json({
        ok: true,
        status: result.status,
        loyverseCustomerId: result.loyverseCustomerId,
      });
    } catch (error) {
      await logSyncEvent(supabase, {
        authUserId: user.id,
        traceId,
        eventType: "loyverse_error",
        detail: { message: safeDetail(error?.message || error), status: error?.status },
      });
      await supabase
        .from("customers")
        .update({ loyverse_sync_status: "failed" })
        .eq("auth_user_id", user.id);
      return json({ ok: false, code: "loyverse_unavailable", traceId, retriable: true }, 502);
    }
  } catch (error) {
    return json({ ok: false, code: "internal_error", retriable: true }, 500);
  }
});