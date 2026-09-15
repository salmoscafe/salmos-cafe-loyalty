// ---------------------------------------------------------------
// loyverse-receipts-sync — Edge Function del sync de receipts (Fase D2-v1).
//
// Pipeline:
//   Scheduler (cron externo) → loyverse-receipts-sync → x-sync-secret
//   → claim atómico sobre loyverse_sync_state → GET /v1.0/receipts
//   (window updated_at incremental) → register_visit / cancel_visit_by_sale
//   → checkpoint (watermark + estado) → PostgreSQL
//
// Seguridad:
//   * NO usa JWT de usuario: es una función server-side/scheduled. La
//     protección es un secreto compartido (`x-sync-secret` ==
//     SYNC_CRON_SECRET) que solo conoce el scheduler y esta función.
//     verify_jwt = false en supabase/config.toml (sección nueva).
//   * Todo el acceso a la BD va con SUPABASE_SERVICE_ROLE_KEY (lado
//     servidor, jamás VITE_*, jamás en el bundle). Las RPCs tienen
//     grants exclusivos de service_role (0005/0007); loyverse_sync_state
//     y audit_logs son inaccesibles para clientes (RLS sin políticas).
//   * El token de Loyverse (LOYVERSE_ACCESS_TOKEN) vive SOLO aquí.
//
// Consistencia > velocidad (idempotencia en PostgreSQL):
//   * Un mismo receipt jamás genera dos visitas (external_sale_id UNIQUE,
//     formato determinístico loyverse_receipt_<store_id>_<receipt_number>).
//   * El watermark (updated_at_min) solo avanza si la corrida TERMINA sin
//     errores de infraestructura; ante fallo se reprocesa la ventana.
//     Los conflictos de NEGOCIO (P0001: reward redimida, ya visitó hoy…)
//     NO bloquean el advance: se reportan por diagnóstico.
//   * Claim atómico (estilo 0006) sobre loyverse_sync_state: una corrida
//     por vez; el perdedor responde 409 retriable (lease 10 min).
//
// Despliegue: supabase functions deploy loyverse-receipts-sync
// Vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LOYVERSE_ACCESS_TOKEN,
//       SYNC_CRON_SECRET
// ---------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { acquireSyncClaim, releaseSyncClaim } from "../_shared/syncClaim.js";
import {
  buildCustomerMap,
  buildRegisterVisitWithReceiptArgs,
  decideReceiptAction,
} from "../_shared/receiptsSyncCore.js";

const LOYVERSE_RECEIPTS_BASE = "https://api.loyverse.com/v1.0/receipts";
const LOYVERSE_PAGE_LIMIT = 250; // máximo de la API
const LOYVERSE_MAX_PAGES = 40; // tope defensivo por corrida (≤ 10,000 receipts)
const LOYVERSE_WINDOW_DAYS = 30; // plan gratuito: solo últimos 31 días de historial
const SYNC_STATE_LEASE_MS = 10 * 60 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
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

// Visitante de success de una RPC (sin stack traces en respuestas).
function rpcErrorOf(error) {
  return { status: error?.status, code: error?.code, message: safeDetail(error?.message) };
}

// ¿La RPC no existe en el schema? (0010 aún no aplicada). PostgREST
// responde PGRST202 ("Could not find the function … in the schema
// cache"). Se detecta también por mensaje por robustez.
function isMissingRpcFunction(error) {
  return error?.code === "PGRST202" || /could not find the function/i.test(safeDetail(error?.message || ""));
}

// ---------------------------------------------------------------
// Transporte hacia la API de Loyverse (token SOLO aquí).
// GET /v1.0/receipts con updated_at_min/max + cursor (mismos filtros en
// toda la secuencia de páginas, como exige la API).
// ---------------------------------------------------------------
function createReceiptsTransport(accessToken) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  async function request(url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const error = new Error(`Loyverse request failed with ${res.status}`);
      error.status = res.status;
      error.body = await res.text();
      console.log("[diag] Loyverse status:", error.status, "body:", error.body);
      throw error;
    }
    return res.json();
  }

  return {
    async list({ limit = LOYVERSE_PAGE_LIMIT, cursor = null, updatedAtMin = null, updatedAtMax = null } = {}) {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (cursor) params.set("cursor", cursor);
      if (updatedAtMin) params.set("updated_at_min", new Date(updatedAtMin).toISOString());
      if (updatedAtMax) params.set("updated_at_max", new Date(updatedAtMax).toISOString());
      const url = `${LOYVERSE_RECEIPTS_BASE}?${params.toString()}`;
      console.log("[diag] Loyverse receipts URL:", url);
      const data = await request(url);
      return { receipts: data.receipts || [], cursor: data.cursor || null };
    },
  };
}

// ---------------------------------------------------------------
// Claim atómico sobre loyverse_sync_state (migración 0007, estilo 0006).
// `authUserId` = el id de la fila de estado (el claim vive por fila).
// ---------------------------------------------------------------
function createStateClaimDb(supabase) {
  return {
    async claim({ authUserId, claim, claimAt, cutoffIso }) {
      const { data, error } = await supabase
        .from("loyverse_sync_state")
        .update({ sync_token: claim, sync_token_at: claimAt })
        .eq("id", authUserId)
        .or(`sync_token.is.null,sync_token_at.lt.${cutoffIso}`)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      return { count: data ? 1 : 0 };
    },
    async release({ authUserId, claim }) {
      const { error } = await supabase
        .from("loyverse_sync_state")
        .update({ sync_token: null, sync_token_at: null })
        .eq("id", authUserId)
        .eq("sync_token", claim);
      return { error };
    },
  };
}

// Fila global única (store_id NULL) con el checkpoint. El índice único
// parcial ((1) WHERE store_id IS NULL) de 0007 hace la creación atómica.
async function getOrCreateStateRow(supabase) {
  const { data: existing, error: readError } = await supabase
    .from("loyverse_sync_state")
    .select("*")
    .is("store_id", null)
    .maybeSingle();
  if (readError) throw readError;
  if (existing) return existing;

  const { data, error } = await supabase
    .from("loyverse_sync_state")
    .insert({ store_id: null })
    .select("*")
    .maybeSingle();
  if (error && error.code === "23505") {
    const { data: again } = await supabase
      .from("loyverse_sync_state")
      .select("*")
      .is("store_id", null)
      .maybeSingle();
    if (again) return again;
  }
  if (error) throw error;
  return data;
}

// Reparo/clamp del checkpoint inicial (plan gratuito de Loyverse).
// El default de la tabla (migración 0007) es now() - '90 days': fuera de la
// ventana permitida de 31 días, y la API responde HTTP 402 PAYMENT_REQUIRED.
// Aquí el watermark inicial queda en now - 30 días. La condición guarda por
// updated_at_min >= allowedMin: si ya existe un watermark progresivo reciente
// (corridas posteriores), el clamp no hace nada ni regresa el avance.
async function clampInitialCheckpoint(supabase, state) {
  const allowedMin = new Date(Date.now() - LOYVERSE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const allowedMinIso = allowedMin.toISOString();
  const current = state.updated_at_min ? new Date(state.updated_at_min).getTime() : 0;
  if (current >= allowedMin.getTime()) return state;

  const { error } = await supabase
    .from("loyverse_sync_state")
    .update({ updated_at_min: allowedMinIso })
    .eq("id", state.id)
    .or(`updated_at_min.is.null,updated_at_min.lt.${allowedMinIso}`);
  if (error) throw error;

  const { data, error: readError } = await supabase
    .from("loyverse_sync_state")
    .select("*")
    .eq("id", state.id)
    .maybeSingle();
  if (readError) throw readError;
  return data ?? { ...state, updated_at_min: allowedMinIso };
}

// Clientes de Salmos con loyverse_customer_id (mapa de resolución).
async function fetchMappedCustomers(supabase) {
  const { data, error } = await supabase
    .from("customers")
    .select("id, loyverse_customer_id")
    .not("loyverse_customer_id", "is", null)
    .limit(5000);
  if (error) throw error;
  return data || [];
}

// ---------------------------------------------------------------
// Pipeline: página por página dentro de una ventana updated_at fija.
//   * La ventana superior (updatedAtMax) se congela al iniciar para no
//     perder receipts que lleguen a mitad de corrida.
//   * Si termina SIN errores de infraestructura, el watermark avanza a
//     updatedAtMax (at-least-once); idempotencia por UNIQUE external_sale_id.
//   * Errores de NEGOCIO (P0001 de las RPC) se cuentan y reportan, no
//     bloquean el avance (un rerun no los resolvería).
// Devuelve el resumen para persistir en el checkpoint y responder.
// ---------------------------------------------------------------
async function runReceiptsSync({ supabase, state, transport }) {
  const counts = {
    receipts: 0,
    pages: 0,
    registered: 0,
    reused: 0,
    cancelled: 0,
    cancelled_already: 0,
    business_skipped: 0,
    business_conflicts: 0,
    no_customer: 0,
    below_minimum: 0,
    unmapped_customer: 0,
    invalid: 0,
    detail_unavailable: 0,
  };
  const conflicts = [];
  const storeIds = new Set();
  const customerMap = buildCustomerMap(await fetchMappedCustomers(supabase));

  const updatedAtMin = state.updated_at_min;
  const updatedAtMax = new Date().toISOString();

  let cursor = state.cursor || null;
  let pages = 0;
  let drained = false;
  let blockingError = null;

  while (pages < LOYVERSE_MAX_PAGES) {
    const page = await transport.list({ limit: LOYVERSE_PAGE_LIMIT, cursor, updatedAtMin, updatedAtMax });
    pages++;
    counts.pages = pages;
    const receipts = page.receipts || [];
    counts.receipts += receipts.length;

    if (!receipts.length) {
      drained = true;
      break;
    }

    for (const receipt of receipts) {
      if (receipt.store_id) storeIds.add(receipt.store_id);

      const decision = decideReceiptAction({ receipt, customerMap });

      if (decision.action === "ignore") {
        if (decision.reason === "no_customer") counts.no_customer++;
        else if (decision.reason === "below_minimum") counts.below_minimum++;
        else if (decision.reason === "unmapped_customer") counts.unmapped_customer++;
        else counts.invalid++;
        continue;
      }

      if (decision.action === "cancel") {
        const { data, error } = await supabase.rpc("cancel_visit_by_sale", decision.cancelArgs);
        if (error) {
          // P0001 = estado de negocio permanente (reward redimida / ciclo
          // sin reward / visita no generadora): reportar y avanzar.
          if (error.code === "P0001") {
            counts.business_conflicts++;
            if (conflicts.length < 20) {
              conflicts.push({ type: "cancel", externalSaleId: decision.externalSaleId, message: safeDetail(error.message) });
            }
          } else {
            counts.business_skipped++;
            if (!blockingError) blockingError = rpcErrorOf(error);
          }
          continue;
        }
        if (data?.visit_found === false || data?.already_cancelled === true) counts.cancelled_already++;
        else counts.cancelled++;
        continue;
      }

      // decision.action === "register"
      // 0010: register_visit_with_receipt = register_visit (reglas intactas)
      // + persiste el detalle del ticket (line_items → items, receipt_date).
      // Si 0010 aún NO está aplicada en la BD (la RPC no existe en el
      // schema, PGRST202), NO se pierde la visita: se registra con
      // register_visit (mismas reglas de lealtad) y se cuenta
      // detail_unavailable en el diagnóstico. El detalle llega en cuanto
      // la migración se despliegue; nunca se inventa un ticket.
      const detailArgs = buildRegisterVisitWithReceiptArgs({ registerArgs: decision.registerArgs, receipt });
      let outcome = await supabase.rpc("register_visit_with_receipt", detailArgs);
      if (outcome.error && isMissingRpcFunction(outcome.error)) {
        counts.detail_unavailable++;
        outcome = await supabase.rpc("register_visit", decision.registerArgs);
      }
      if (outcome.error) {
        // P0001 = regla de negocio (ya visitó hoy, mínimo…): avance seguro.
        if (outcome.error.code === "P0001") {
          counts.business_skipped++;
          if (conflicts.length < 20) {
            conflicts.push({ type: "register", externalSaleId: decision.externalSaleId, message: safeDetail(outcome.error.message) });
          }
        } else {
          counts.business_skipped++;
          if (!blockingError) blockingError = rpcErrorOf(outcome.error);
        }
        continue;
      }
      if (outcome.data?.reused === true) counts.reused++;
      else counts.registered++;
    }

    cursor = page.cursor;
    if (!cursor) {
      drained = true;
      break;
    }
  }

  if (!drained && !blockingError) {
    blockingError = {
      code: "PIPELINE_TRUNCATED",
      message: `Se alcanzó el tope de ${LOYVERSE_MAX_PAGES} páginas sin agotar los receipts de la ventana. La ventana no avanzó; se reintentará.`,
    };
  }

  return {
    window: { updatedAtMin, updatedAtMax, advanced: !blockingError },
    pages,
    processed: counts.receipts,
    counts,
    conflicts,
    storeIds: [...storeIds],
    blockingError,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed", retriable: false }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const loyverseAccessToken = Deno.env.get("LOYVERSE_ACCESS_TOKEN") || "";
  const syncSecret = Deno.env.get("SYNC_CRON_SECRET") || "";

  if (!supabaseUrl || !serviceRoleKey || !loyverseAccessToken || !syncSecret) {
    return json({ ok: false, code: "srv_not_configured", retriable: true }, 503);
  }

  const provided = req.headers.get("x-sync-secret") || "";
  if (provided !== syncSecret) {
    return json({ ok: false, code: "unauthorized", retriable: false }, 401);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    let state = await getOrCreateStateRow(supabase);
    state = await clampInitialCheckpoint(supabase, state);
    const claimDb = createStateClaimDb(supabase);

    const acquisition = await acquireSyncClaim(claimDb, state.id, {
      leaseMs: SYNC_STATE_LEASE_MS,
    });
    if (!acquisition.acquired) {
      return json({ ok: false, code: "sync_in_progress", retriable: true }, 409);
    }

    const claim = acquisition.claim;
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      await supabase
        .from("loyverse_sync_state")
        .update({
          last_status: "running",
          last_error: null,
          error_detail: null,
          last_run_at: now,
        })
        .eq("id", state.id)
        .eq("sync_token", claim);

      const transport = createReceiptsTransport(loyverseAccessToken);
      const outcome = await runReceiptsSync({ supabase, state, transport });

      if (outcome.blockingError) {
        await supabase
          .from("loyverse_sync_state")
          .update({
            cursor: null,
            updated_at_max: outcome.window.updatedAtMax,
            processed: outcome.processed,
            last_run_at: now,
            last_status: "error",
            last_error: safeDetail(outcome.blockingError.message),
            error_detail: {
              code: outcome.blockingError.code,
              status: outcome.blockingError.status ?? null,
              counts: outcome.counts,
              conflicts: outcome.conflicts,
            },
          })
          .eq("id", state.id)
          .eq("sync_token", claim);

        return json(
          {
            ok: false,
            runId,
            code: "sync_retriable_error",
            retriable: true,
            window: outcome.window,
            processed: outcome.processed,
            counts: outcome.counts,
            conflicts: outcome.conflicts,
            error: { code: outcome.blockingError.code, message: safeDetail(outcome.blockingError.message) },
          },
          502
        );
      }

      await supabase
        .from("loyverse_sync_state")
        .update({
          cursor: null,
          updated_at_min: outcome.window.updatedAtMax,
          updated_at_max: outcome.window.updatedAtMax,
          processed: outcome.processed,
          last_run_at: now,
          last_status: "ok",
          last_error: null,
          error_detail: outcome.conflicts.length ? { conflicts: outcome.conflicts } : null,
        })
        .eq("id", state.id)
        .eq("sync_token", claim);

      return json(
        {
          ok: true,
          runId,
          window: outcome.window,
          pages: outcome.pages,
          processed: outcome.processed,
          counts: outcome.counts,
          conflicts: outcome.conflicts,
          storeIds: outcome.storeIds,
        },
        200
      );
    } catch (error) {
      // Error de transporte/infraestructura: se marca el estado pero NO se
      // avanza el watermark → la próxima corrida reprocesa (idempotente).
      await supabase
        .from("loyverse_sync_state")
        .update({
          cursor: null,
          last_run_at: now,
          last_status: "error",
          last_error: safeDetail(error?.message || error),
          error_detail: { status: error?.status, code: error?.code },
        })
        .eq("id", state.id)
        .eq("sync_token", claim);
      return json({ ok: false, runId, code: "sync_failed", retriable: true, message: safeDetail(error?.message || error) }, 502);
    } finally {
      try {
        await releaseSyncClaim(claimDb, state.id, claim);
      } catch {
        // La liberación falló pero el lease expirará el claim (10 min);
        // nunca enmascarar el resultado principal.
      }
    }
  } catch (error) {
    return json({ ok: false, code: "internal_error", retriable: true }, 500);
  }
});