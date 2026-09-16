// ---------------------------------------------------------------
// loyalty-engine — Edge Function segura del motor de lealtad (D1.2).
//
// Pipeline:
//   Frontend futuro → loyalty-engine → JWT validation → profile lookup
//   (public.profiles vía service_role) → actor policy → RPCs
//   (register_visit / cancel_visit / redeem_reward) → PostgreSQL
//
// La función es una capa de validación y ENVOLTURA, NO la fuente de
// verdad de las reglas de negocio. Las reglas ($50, 1 visita/día,
// 7ª visita, expiración, cancelación, idempotencia) viven en las RPCs
// de 0005_loyalty_engine.sql. Aquí solo se valida:
//   * autenticación (JWT);
//   * formato del payload;
//   * autorización / actor policy — el rol se lee de public.profiles
//     con service_role (CHECKPOINT 1: customer | staff | admin);
//   * timezone (fecha de negocio en servidor);
//   * llamada segura a la RPC con service_role.
//
// Seguridad:
//   * Requiere Authorization: Bearer <JWT> (verify_jwt = true en
//     supabase/config.toml) y además se valida el usuario con
//     auth.getUser (defense-in-depth, igual que loyverse-customers).
//   * El actor NUNCA proviene del payload: actorId/actorRole en el
//     body son rechazados. El rol se determina server-side leyendo
//     public.profiles (id = auth.uid()); nunca user_metadata.
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
  buildLookupResult,
  buildResponseBody,
  buildRpcArgs,
  decideActorPolicy,
  decideLookupPolicy,
  getBusinessDate,
  isFutureDate,
  isValidUuid,
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
// `lookup` NO tiene RPC: es una LECTURA staff-only que hace la Edge
// con service_role leyendo customers/cycles/visits/rewards (CP3.1).
const RPC_BY_OPERATION = {
  visit: "register_visit",
  cancel: "cancel_visit",
  redeem: "redeem_reward",
};

const LOOKUP_REWARD_SELECT =
  "id, cycle_id, status, expires_at, max_value";

// Consulta public.profiles con service_role (fuente de verdad del rol).
// Devuelve { id, role, name, active } o null. El lookup va por
// service_role para no depender de RLS ni de metadatos del JWT.
async function fetchProfile(serviceClient, userId) {
  const { data, error } = await serviceClient
    .from("profiles")
    .select("id, role, name, active")
    .eq("id", userId)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

// ---------------------------------------------------------------
// serveLookup — consulta de cliente por QR token (CP3.1 + CP3.2).
//   * Autorización: la resolución del rol YA ocurrió en decideLookupPolicy;
//     este helper NO vuelve a decidir nada, solo arma la respuesta.
//   * Consultas: customers (por customer_code), loyalty_cycles (el activo),
//     loyalty_visits (solo activas), rewards (el disponible del ciclo).
//     Todo con service_client (service_role, BYPASSRLS) → el Staff puede
//     consultar clientes ajenos aunque la RLS de customers sea solo-lectura
//     del dueño. Es LECTURA pura: no escribe nada (ni audit_logs).
//   * CP3.2: customers se selecciona con loyverse_customer_id ÚNICAMENTE
//     para que buildLookupResult derive `loyverse_mapped` en servidor. Ese
//     id jamás sale en la respuesta (el core lo strippea a booleano); la UI
//     Staff nunca ve el vínculo real de Loyverse, solo si está mapeado.
//   * Errores controlados: nunca se exponen errores internos de Supabase.
//   * Respuesta: buildLookupResult (customer / cycle / progress / reward).
// ---------------------------------------------------------------
async function serveLookup(serviceClient, token) {
  try {
    const { data: customers, error: customerError } = await serviceClient
      .from("customers")
      .select("id, name, customer_code, loyverse_customer_id")
      .eq("customer_code", token)
      .limit(1);

    if (customerError) throw customerError;
    const customer = customers?.[0] || null;
    if (!customer) {
      return json(buildErrorResponseBody("CUSTOMER_NOT_FOUND", "Cliente no encontrado."), 404);
    }

    // 2) Ciclo activo del cliente (índice parcial status='active').
    const { data: cycles, error: cycleError } = await serviceClient
      .from("loyalty_cycles")
      .select("id, cycle_number, required_visits, status")
      .eq("customer_id", customer.id)
      .eq("status", "active")
      .limit(1);
    if (cycleError) throw cycleError;
    const cycle = cycles?.[0] || null;

    let activeVisits = 0;
    let reward = null;

    if (cycle) {
      // 3) Progreso = visitas activas del ciclo.
      const { count, error: visitsError } = await serviceClient
        .from("loyalty_visits")
        .select("id", { count: "exact", head: true })
        .eq("cycle_id", cycle.id)
        .eq("status", "active");
      if (visitsError) throw visitsError;
      activeVisits = count || 0;

      // 4) Recompensa disponible del ciclo (el UNIQUE en cycle_id
      //    garantiza a lo sumo una fila).
      const { data: rewards, error: rewardError } = await serviceClient
        .from("rewards")
        .select(LOOKUP_REWARD_SELECT)
        .eq("cycle_id", cycle.id)
        .order("expires_at", { ascending: true })
        .limit(1);
      if (rewardError) throw rewardError;
      reward = rewards?.[0] || null;
    }

    // 5) Respuesta pura (customer / cycle / progress / reward).
    const result = buildLookupResult({ customer, cycle, activeVisits, reward });
    return json(result, 200);
  } catch {
    return json(buildErrorResponseBody("INTERNAL", "No se pudo consultar el cliente. Intenta nuevamente."), 500);
  }
}

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
    // las mutaciones van por service_role en el paso 4.
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
    // 4) Cliente service_role (grants 0005) — además de ejecutar las
    //    RPCs, resuelve el rol desde public.profiles. Al ser la fuente
    //    de verdad del rol, el lookup va por service_role (BYPASSRLS):
    //    nunca se confía en el rol que el frontend envíe ni en metadatos
    //    del JWT que el usuario podría manipular.
    // ---------------------------------------------------------------
    if (!serviceRoleKey) {
      return json(buildErrorResponseBody("SRV_NOT_CONFIGURED", "Servicio no configurado."), 503);
    }
    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const profile = await fetchProfile(serviceClient, user.id);

    // ---------------------------------------------------------------
    // 5) Actor policy (el actor se deriva de la sesión + profiles,
    //    jamás del body). El rol lo decide public.profiles server-side.
    //    lookup es staff-only con su propio policy (CP3.1): reutiliza
    //    el mismo perfil, pero rechaza customer/inactivo con códigos
    //    específicos y no resuelve un "actor que muta".
    // ---------------------------------------------------------------
    const policy = operation === "lookup"
      ? decideLookupPolicy({ user, profile })
      : decideActorPolicy({ operation, user, profile });
    if (!policy.allowed) {
      return json(
        buildErrorResponseBody(policy.error.code, policy.error.message),
        policy.error.status
      );
    }

    // lookup: rama de LECTURA pura (sin RPC, sin visita, sin actor).
    // Se devuelve antes de tocar la fecha de negocio / buildRpcArgs,
    // porque no muta nada. Consulta con service_role (BYPASSRLS) para
    // poder leer el cliente por QR aunque el Staff no sea el dueño.
    if (operation === "lookup") {
      return await serveLookup(serviceClient, payloadCheck.data.token);
    }

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