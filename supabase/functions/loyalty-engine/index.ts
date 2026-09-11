// ---------------------------------------------------------------
// loyalty-engine — Edge Function segura del motor de lealtad (D1.2).
//
// Pipeline:
//   Frontend futuro → loyalty-engine → JWT validation → actor policy
//   → Supabase service_role client → register_visit / cancel_visit /
//     redeem_reward → PostgreSQL
//
// La función es una capa de validación y ENVOLTURA, NO la fuente de
// verdad de las reglas de negocio. Las reglas ($50, 1 visita/día,
// 8ª visita, expiración, cancelación, idempotencia) viven en las RPCs
// de 0005_loyalty_engine.sql. Aquí solo se valida:
//   * autenticación (JWT);
//   * formato del payload;
//   * autorización / actor policy;
//   * timezone (fecha de negocio en servidor);
//   * llamada segura a la RPC con service_role.
//
// Seguridad:
//   * Requiere Authorization: Bearer <JWT> (verify_jwt = true en
//     supabase/config.toml) y además se valida el usuario con
//     auth.getUser (defense-in-depth, igual que loyverse-customers).
//   * El actor NUNCA proviene del payload: actorId/actorRole en el
//     body son rechazados. El actor se deriva de la sesión (hoy todo
//     usuario autenticado es customer y las tres operaciones son
//     staff-only → denegadas con códigos explícitos).
//   * Las RPCs tienen grants SOLO para service_role; por eso la
//     función usa SUPABASE_SERVICE_ROLE_KEY (lado servidor). Esa key
//     jamás es VITE_*, jamás existe en src/ ni en el bundle.
//
// Despliegue: supabase functions deploy loyalty-engine
// Vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// ---------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  BUSINESS_TIMEZONE,
  buildErrorResponseBody,
  buildResponseBody,
  buildRpcArgs,
  decideActorPolicy,
  getBusinessDate,
  isFutureDate,
  mapRpcError,
  parseBearer,
  parseJsonBody,
  validateOperation,
  validatePayload,
} from "../_shared/loyaltyEngineCore.js";

// Mismo estilo CORS que loyverse-customers (patrón del proyecto).
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

// Nombre real de la RPC según la operación (firmas de 0005).
const RPC_BY_OPERATION = {
  visit: "register_visit",
  cancel: "cancel_visit",
  redeem: "redeem_reward",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(buildErrorResponseBody("METHOD_NOT_ALLOWED", "Solo se acepta POST."), 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  try {
    // ---------------------------------------------------------------
    // 1) Autenticación: JWT del usuario.
    // ---------------------------------------------------------------
    const authHeader = req.headers.get("Authorization") || "";
    const token = parseBearer(authHeader);
    if (!token) {
      return json(buildErrorResponseBody("UNAUTHORIZED", "Autenticación requerida."), 401);
    }

    if (!supabaseUrl || !supabaseAnonKey) {
      return json(buildErrorResponseBody("SRV_NOT_CONFIGURED", "Servicio no configurado."), 503);
    }

    // Cliente anon SOLO para validar el usuario (RLS del propio JWT);
    // las mutaciones van por service_role en el paso 5.
    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser(token);
    if (authError || !user) {
      return json(buildErrorResponseBody("UNAUTHORIZED", "Autenticación requerida."), 401);
    }

    // ---------------------------------------------------------------
    // 2) Cuerpo JSON.
    // ---------------------------------------------------------------
    const rawBody = await req.text();
    const parsed = await parseJsonBody(rawBody);
    if (!parsed.ok) {
      return json(buildErrorResponseBody(parsed.error.code, parsed.error.message), parsed.error.status);
    }
    const body = parsed.data;

    // ---------------------------------------------------------------
    // 3) Operación + payload.
    // ---------------------------------------------------------------
    const operation = body?.operation;
    const opCheck = validateOperation(operation);
    if (!opCheck.ok) {
      return json(buildErrorResponseBody(opCheck.error.code, opCheck.error.message), opCheck.error.status);
    }

    const payloadCheck = validatePayload(operation, body);
    if (!payloadCheck.ok) {
      return json(
        buildErrorResponseBody(payloadCheck.error.code, payloadCheck.error.message),
        payloadCheck.error.status
      );
    }

    // ---------------------------------------------------------------
    // 4) Actor policy (el actor se deriva de la sesión, jamás del body).
    // Hoy visit/cancel/redeem son staff-only y no hay identidad Staff
    // verificable → la política deniega con códigos explícitos.
    // ---------------------------------------------------------------
    const policy = decideActorPolicy({ operation, user });
    if (!policy.allowed) {
      return json(
        buildErrorResponseBody(policy.error.code, policy.error.message),
        policy.error.status
      );
    }

    // ---------------------------------------------------------------
    // 5) Cliente service_role para ejecutar las RPCs (grants 0005).
    // ---------------------------------------------------------------
    if (!serviceRoleKey) {
      return json(buildErrorResponseBody("SRV_NOT_CONFIGURED", "Servicio no configurado."), 503);
    }
    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ---------------------------------------------------------------
    // 6) Fecha de negocio en servidor (America/Tijuana) — nunca el
    //    navegador, nunca UTC. Solo relevant para `visit`.
    //    isFutureDate es una guardia defensiva: la fecha derivada de
    //    `now` no puede ser futura; la RPC tiene su propia barrera.
    // ---------------------------------------------------------------
    const now = new Date();
    const visitDate = getBusinessDate(now, BUSINESS_TIMEZONE);
    if (isFutureDate(visitDate, now, BUSINESS_TIMEZONE)) {
      return json(buildErrorResponseBody("INTERNAL", "Fecha de negocio inválida."), 500);
    }

    const actor = policy.actor;
    if (!actor) {
      return json(buildErrorResponseBody("INTERNAL", "Actor no resuelto."), 500);
    }

    // ---------------------------------------------------------------
    // 7) Llamada a la RPC y respuesta controlada.
    // ---------------------------------------------------------------
    const rpcArgs =
      operation === "visit"
        ? buildRpcArgs(operation, payloadCheck.data, { visitDate, actor, source: "manual" })
        : buildRpcArgs(operation, payloadCheck.data, { actor });

    const { data, error } = await serviceClient.rpc(RPC_BY_OPERATION[operation], rpcArgs);

    if (error) {
      const mapped = mapRpcError(error);
      return json(buildErrorResponseBody(mapped.code, mapped.message), mapped.status);
    }

    // El `result` del RPC (JSONB) incluye `reused` cuando el
    // external_sale_id ya existía — idempotencia delegada a PostgreSQL.
    return json(buildResponseBody(operation, data), 200);
  } catch {
    // Nunca exponer internals (stack traces, SQL, keys).
    return json(buildErrorResponseBody("INTERNAL", "Error interno de la operación."), 500);
  }
});