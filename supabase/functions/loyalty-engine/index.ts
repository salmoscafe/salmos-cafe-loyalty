// ---------------------------------------------------------------
// loyalty-engine — Edge Function segura del motor de lealtad (D1.2).
//
// Pipeline:
//   Frontend futuro → loyalty-engine → JWT validation → profile lookup
//   (public.profiles vía service_role) → actor policy → RPCs
//   (register_visit / cancel_visit / redeem_reward) → PostgreSQL
//   claim_start NO va a una RPC: inserta en reward_claims (0016) con
//   service_role y devuelve el OTP en claro al customer dueño.
//   claim_verify va a verify_reward_claim (0017): la Edge recomputa el
//   HMAC con la pepper y la RPC hace pending → verified.
//   redeem_reward (0017) exige una claim 'verified': sin ella no canjea.
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
//     función usa la SECRET KEY nueva (SUPABASE_SECRET_KEYS) del lado
//     servidor. Esa key jamás es VITE_*, jamás existe en src/ ni en
//     el bundle. La validación del JWT del usuario usa la PUBLISHABLE
//     KEY nueva (SUPABASE_PUBLISHABLE_KEYS).
//
// Despliegue: supabase functions deploy loyalty-engine
// Vars: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEYS, SUPABASE_SECRET_KEYS,
//       LOYALTY_OTP_PEPPER (obligatoria para claim_start; fail-closed).
// ---------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  BUSINESS_TIMEZONE,
  buildClaimStartResponse,
  buildErrorResponseBody,
  buildLookupResult,
  buildResponseBody,
  buildRpcArgs,
  decideActorPolicy,
  decideLookupPolicy,
  extractOtpSalt,
  generateOtpCode,
  getBusinessDate,
  getOtpExpiry,
  hashOtp,
  isFutureDate,
  isValidOtpHashFormat,
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

// Las nuevas API keys de Supabase llegan al runtime como un diccionario
// JSON por nombre (`{"default":"sb_..."}`), no como string plano. Se lee
// la key "default" sin registrar el valor en logs; si falta, está
// corrupta o no existe "default", devuelve "" y el handler responde 503
// (fail-closed). Nunca se hardcodea ni se expone el valor.
function readDefaultKey(rawJson) {
  if (!rawJson) return "";
  try {
    const parsed = JSON.parse(rawJson);
    if (parsed && typeof parsed === "object" && typeof parsed["default"] === "string") {
      return parsed["default"];
    }
  } catch {
    // JSON inválido → sin key (fail-closed).
  }
  return "";
}

// Nombre real de la RPC según la operación (firmas de 0005).
// `lookup` NO tiene RPC: es una LECTURA staff-only que hace la Edge
// con service_role leyendo customers/cycles/visits/rewards (CP3.1).
// `claim_start` NO tiene RPC: pide el OTP del CUSTOMER dueño de su
// recompensa e inserta en reward_claims (0016) con service_role.
// `claim_verify` va a verify_reward_claim (0017): Staff/Admin valida
// el OTP y la RPC hace pending → verified.
const RPC_BY_OPERATION = {
  visit: "register_visit",
  cancel: "cancel_visit",
  redeem: "redeem_reward",
  claim_verify: "verify_reward_claim",
};

// Valor centinela con formato válido `saltHex:hexHMAC` para cuando NO hay
// claim pending: la RPC 0017 recibe un candidato que nunca coincide y
// responde con el motivo específico (CLAIM_NOT_FOUND / ALREADY_*).
// El OTP real JAMÁS se registra en logs.
const NO_PENDING_CANDIDATE = `${"0".repeat(32)}:${"0".repeat(64)}`;

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

// ---------------------------------------------------------------
// serveClaimStart — el CUSTOMER pide el OTP de su propia recompensa.
//   * Actor: la política ya garantizó customer (el profile se resolvió
//     antes con service_role). El customerId de reward_claims se deriva
//     aquí de customers.auth_user_id = user.id: jamás del payload.
//   * Recompensa: se valida existencia, propiedad, status 'available' y
//     expires_at futuro con service_role (RLS de rewards es solo-lectura).
//   * Cancelación previa: cualquier claim 'pending' del mismo reward se
//     pasa a 'cancelled' antes de insertar (el índice parcial
//     reward_claims_one_pending_per_reward_idx de 0016 garantiza a lo
//     sumo un pending por reward; el 23505 se mapea a conflicto).
//   * OTP: 6 dígitos en claro generados en servidor y SOLO se devuelven
//     al cliente autenticado que pide su propia recompensa. En la DB va
//     el hash HMAC-SHA256 con la pepper LOYALTY_OTP_PEPPER (fail-closed:
//     si la pepper falta, 503 — nunca se genera OTP sin hashear).
//   * Respuesta de contrato: { ok, rewardId, otp, expiresAt } — NUNCA
//     otp_hash (ese hash solo existe en reward_claims vía service_role).
// ---------------------------------------------------------------
async function serveClaimStart({ serviceClient, userId, rewardId, pepper, now }) {
  try {
    const { data: customer, error: customerError } = await serviceClient
      .from("customers")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (customerError) throw customerError;
    if (!customer) {
      return json(buildErrorResponseBody("CUSTOMER_NOT_FOUND", "Cliente no encontrado."), 404);
    }

    const { data: reward, error: rewardError } = await serviceClient
      .from("rewards")
      .select("id, customer_id, status, expires_at")
      .eq("id", rewardId)
      .maybeSingle();
    if (rewardError) throw rewardError;
    if (!reward) {
      return json(buildErrorResponseBody("REWARD_NOT_FOUND", "Recompensa no encontrada."), 404);
    }
    if (reward.customer_id !== customer.id) {
      return json(buildErrorResponseBody("REWARD_NOT_OWNED", "Esta recompensa no te pertenece."), 403);
    }
    if (reward.status === "redeemed") {
      return json(buildErrorResponseBody("REWARD_ALREADY_REDEEMED", "Esta recompensa ya fue canjeada."), 400);
    }
    if (reward.status !== "available") {
      return json(buildErrorResponseBody("REWARD_NOT_AVAILABLE", "Esta recompensa ya no está disponible."), 400);
    }
    if (new Date(reward.expires_at).getTime() <= now.getTime()) {
      return json(buildErrorResponseBody("REWARD_EXPIRED", "Esta recompensa ya venció."), 400);
    }

    // Un solo claim 'pending' por reward (constraint de 0016): cancelar
    // el anterior si existe deja paso al nuevo OTP.
    const { error: cancelError } = await serviceClient
      .from("reward_claims")
      .update({ status: "cancelled" })
      .eq("reward_id", rewardId)
      .eq("status", "pending");
    if (cancelError) throw cancelError;

    const otp = generateOtpCode();
    const otpHash = await hashOtp({ otp, rewardId, pepper });
    const expiresAt = getOtpExpiry(now);

    const { error: insertError } = await serviceClient
      .from("reward_claims")
      .insert({
        reward_id: rewardId,
        customer_id: customer.id,
        otp_hash: otpHash,
        expires_at: expiresAt.toISOString(),
        status: "pending",
      });
    if (insertError) {
      if (insertError.code === "23505") {
        return json(
          buildErrorResponseBody("CLAIM_PENDING_CONFLICT", "Ya existe una solicitud de OTP en curso para esta recompensa."),
          409
        );
      }
      throw insertError;
    }

    return json(buildClaimStartResponse({ rewardId, otp, expiresAt: expiresAt.toISOString() }), 200);
  } catch {
    return json(buildErrorResponseBody("INTERNAL", "No se pudo generar el OTP. Intenta nuevamente."), 500);
  }
}

// ---------------------------------------------------------------
// computeVerifyCandidate — candidato HMAC para claim_verify (0017).
//   * La pepper vive SOLO aquí (env secret). La Edge recomputa el mismo
//     HMAC-SHA256 que claim_start usando el salt embebido en otp_hash y
//     pasa el candidato a la RPC verify_reward_claim, que compara en
//     tiempo constante contra el hash almacenado.
//   * Si no hay claim 'pending' (o el hash es ilegible), se envía un
//     centinela de formato válido: la RPC responde el motivo exacto sin
//     que aquí se decida ni se filtre información del OTP.
// ---------------------------------------------------------------
async function computeVerifyCandidate({ serviceClient, rewardId, otp, pepper }) {
  const { data: claim, error } = await serviceClient
    .from("reward_claims")
    .select("otp_hash")
    .eq("reward_id", rewardId)
    .eq("status", "pending")
    .maybeSingle();
  if (error) throw error;
  if (!claim || !isValidOtpHashFormat(claim.otp_hash)) {
    return NO_PENDING_CANDIDATE;
  }
  const salt = extractOtpSalt(claim.otp_hash);
  return await hashOtp({ otp, rewardId, pepper, salt });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(buildErrorResponseBody("METHOD_NOT_ALLOWED", "Solo se acepta POST."), 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const publishableKey = readDefaultKey(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"));
  const secretKey = readDefaultKey(Deno.env.get("SUPABASE_SECRET_KEYS"));

  try {
    // ---------------------------------------------------------------
    // 1) Autenticación: JWT del usuario.
    // ---------------------------------------------------------------
    const authHeader = req.headers.get("Authorization") || "";
    const token = parseBearer(authHeader);
    if (!token) {
      return json(buildErrorResponseBody("UNAUTHORIZED", "Autenticación requerida."), 401);
    }

    if (!supabaseUrl || !publishableKey) {
      return json(buildErrorResponseBody("SRV_NOT_CONFIGURED", "Servicio no configurado."), 503);
    }

    // Cliente publishable SOLO para validar el usuario (el JWT del
    // propio usuario); las mutaciones van con la secret key en el paso 4.
    const authClient = createClient(supabaseUrl, publishableKey, {
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
    // 4) Cliente con la SECRET KEY (rol service_role, grants 0005) —
    //    además de ejecutar las RPCs, resuelve el rol desde
    //    public.profiles. Al ser la fuente de verdad del rol, el lookup
    //    va con la secret key (BYPASSRLS): nunca se confía en el rol que
    //    el frontend envíe ni en metadatos del JWT que el usuario podría
    //    manipular.
    // ---------------------------------------------------------------
    if (!secretKey) {
      return json(buildErrorResponseBody("SRV_NOT_CONFIGURED", "Servicio no configurado."), 503);
    }
    const serviceClient = createClient(supabaseUrl, secretKey, {
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

    // claim_start: el CUSTOMER pide el OTP de su recompensa. No es una
    // RPC (inserta en reward_claims por service_role). Fail-closed:
    // si LOYALTY_OTP_PEPPER no está definida, 503 — nunca generar un
    // OTP cuyo hash se calcularía con pepper vacía.
    if (operation === "claim_start") {
      const pepper = Deno.env.get("LOYALTY_OTP_PEPPER") || "";
      if (!pepper) {
        return json(buildErrorResponseBody("SRV_NOT_CONFIGURED", "Servicio no configurado."), 503);
      }
      return await serveClaimStart({
        serviceClient,
        userId: user.id,
        rewardId: payloadCheck.data.rewardId,
        pepper,
        now: new Date(),
      });
    }

    // claim_verify: Staff/Admin valida el OTP de una recompensa (0017).
    // La Edge recomputa el HMAC con la pepper y delega en la RPC
    // verify_reward_claim la comparación en tiempo constante y la
    // transición pending → verified. Fail-closed si falta la pepper.
    if (operation === "claim_verify") {
      const pepper = Deno.env.get("LOYALTY_OTP_PEPPER") || "";
      if (!pepper) {
        return json(buildErrorResponseBody("SRV_NOT_CONFIGURED", "Servicio no configurado."), 503);
      }
      payloadCheck.data.candidateHash = await computeVerifyCandidate({
        serviceClient,
        rewardId: payloadCheck.data.rewardId,
        otp: payloadCheck.data.otp,
        pepper,
      });
      // Continúa al camino genérico de RPC (abajo): buildRpcArgs despacha
      // claim_verify → verify_reward_claim con el candidato ya computado.
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