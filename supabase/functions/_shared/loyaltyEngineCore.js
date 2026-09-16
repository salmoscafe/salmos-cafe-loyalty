// ---------------------------------------------------------------
// loyaltyEngineCore — Lógica pura de la Edge Function `loyalty-engine`.
// Vive del lado servidor (Edge Function) y es el único lugar donde se
// decide: validación de operación/payload, política de actores, fecha
// de negocio, construcción de argumentos para las RPCs de D1.1 y el
// mapeo de errores/resultados.
//
// Es 100% agnóstico del transporte: NO toca Supabase, NO lee secrets,
// NO llama a la red ni a Loyverse, NO importa Deno. Por eso es
// unit-testable con `node --test` (ver tests/loyalty-engine.test.mjs).
//
// Contrato con la migración 0005_loyalty_engine.sql (fuente de verdad
// de las firmas):
//   register_visit(p_customer_id uuid, p_external_sale_id text,
//                  p_amount numeric, p_visit_date date default null,
//                  p_store_id text default null, p_employee_id text
//                  default null, p_source text default 'manual',
//                  p_actor_id text default 'system',
//                  p_actor_role text default 'staff')
//   cancel_visit(p_visit_id uuid, p_actor_id text, p_actor_role text)
//   redeem_reward(p_reward_id uuid, p_actor_id text, p_actor_role text)
// Los nombres y argumentos de build*Args DEBEN coincidir exactamente
// con esa migración.
//
// Principios:
//   * La Edge NO duplica reglas de negocio ($50, 1 visita/día, 7ª
//     visita, expiración...): eso vive en PostgreSQL (RPCs D1.1).
//     Aquí solo se valida formato, operación, actor y timezone.
//   * El actor NUNCA proviene del payload: se deriva de la sesión
//     (JWT) en la Edge. Este core nunca lee actorId/actorRole del
//     body y rechaza esos campos si vienen.
//   * visit_date se calcula en servidor con la timezone comercial
//     (America/Tijuana). El frontend no la manda.
// ---------------------------------------------------------------

// Timezone comercial de Salmos (decisión aprobada en D1.2).
// Evidencia: sucursales en la zona Tijuana/Ensenada (+52 664) y el
// mock histórico usa offsets -08:00/-07:00, no UTC.
export const BUSINESS_TIMEZONE = "America/Tijuana";

// Operaciones expuestas por la Edge Function.
// Está `lookup` porque es LECTURA (la usa Staff para consultar el progreso):
// sigue siendo server-side con service_role, pero NO muta nada y NO va a una RPC.
export const OPERATIONS = Object.freeze(["visit", "cancel", "redeem", "lookup"]);

// Límite defensivo para el token de búsqueda (customer_code = SC-XXXXXXXX,
// 12 chars; tope generoso por si mañana el QR se firma con un payload más largo).
export const LOOKUP_TOKEN_MAX_LENGTH = 40;

// UUID 8-4-4-4-12 (cualquier versión, case-insensitive).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Campos que el cliente NO debe controlar. Rechazarlos explícitamente
// es más seguro que ignorarlos: documenta que no se confía en ellos.
const FORBIDDEN_FIELDS = ["actorId", "actorRole", "visitDate", "visit_date"];

// ---------------------------------------------------------------
// Errores controlados — forma única { code, message, status }.
// ---------------------------------------------------------------
export function errorOf(code, message, status = 400) {
  return { code, message, status };
}

// ---------------------------------------------------------------
// Operation
// ---------------------------------------------------------------
export function validateOperation(value) {
  if (!OPERATIONS.includes(value)) {
    return { ok: false, error: errorOf("INVALID_OPERATION", "Operación no válida. Use visit, cancel, redeem o lookup.") };
  }
  return { ok: true };
}

export function isValidUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// actorId/actorRole NO se aceptan en el payload: el actor es la sesión.
export function assertNoActorFields(payload) {
  if (hasOwn(payload, "actorId") || hasOwn(payload, "actorRole")) {
    return {
      ok: false,
      error: errorOf(
        "ACTOR_FIELDS_NOT_ALLOWED",
        "actorId/actorRole no se aceptan en el payload: el actor se deriva de la sesión autenticada."
      ),
    };
  }
  return { ok: true };
}

// visitDate/visit_date NO se aceptan: la fecha de negocio se calcula en
// servidor con la timezone comercial (America/Tijuana).
export function assertNoVisitDateField(payload) {
  if (hasOwn(payload, "visitDate") || hasOwn(payload, "visit_date")) {
    return {
      ok: false,
      error: errorOf(
        "VISIT_DATE_NOT_ALLOWED",
        "visitDate no se acepta: la fecha de negocio se calcula en servidor."
      ),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------

// visit → { customerId, externalSaleId, amount, storeId?, employeeId?,
//           paymentMethod? }
export function validateVisitPayload(payload) {
  if (!isRecord(payload)) {
    return { ok: false, error: errorOf("INVALID_PAYLOAD", "El cuerpo debe ser un objeto JSON.") };
  }

  const { customerId, externalSaleId, amount, storeId, employeeId, paymentMethod } = payload;

  if (typeof customerId !== "string" || customerId.trim() === "") {
    return { ok: false, error: errorOf("MISSING_CUSTOMER_ID", "customerId es requerido.") };
  }
  if (!isValidUuid(customerId)) {
    return { ok: false, error: errorOf("INVALID_UUID", "customerId debe ser un UUID válido.") };
  }

  if (typeof externalSaleId !== "string" || externalSaleId.trim() === "") {
    return { ok: false, error: errorOf("MISSING_EXTERNAL_SALE_ID", "externalSaleId es requerido.") };
  }

  // Solo formato: número finito positivo. El mínimo de $50 MXN lo
  // decide el RPC (regla de negocio en PostgreSQL, no aquí).
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: errorOf("INVALID_AMOUNT", "amount debe ser un número positivo.") };
  }

  const data = { customerId, externalSaleId, amount };

  if (storeId !== undefined) {
    if (typeof storeId !== "string") {
      return { ok: false, error: errorOf("INVALID_STORE_ID", "storeId debe ser texto.") };
    }
    data.storeId = storeId;
  }

  if (employeeId !== undefined) {
    if (typeof employeeId !== "string") {
      return { ok: false, error: errorOf("INVALID_EMPLOYEE_ID", "employeeId debe ser texto.") };
    }
    data.employeeId = employeeId;
  }

  if (paymentMethod !== undefined) {
    if (typeof paymentMethod !== "string") {
      return { ok: false, error: errorOf("INVALID_PAYMENT_METHOD", "paymentMethod debe ser texto.") };
    }
    // paymentMethod NO pertenece al modelo de loyalty_visits (0005 no
    // agrega esa columna, decisión aprobada). Se valida aquí por
    // compatibilidad, pero buildRegisterVisitArgs jamás lo envía al RPC.
    data.paymentMethod = paymentMethod;
  }

  return { ok: true, data };
}

// cancel → { visitId }
export function validateCancelPayload(payload) {
  if (!isRecord(payload)) {
    return { ok: false, error: errorOf("INVALID_PAYLOAD", "El cuerpo debe ser un objeto JSON.") };
  }
  const { visitId } = payload;
  if (typeof visitId !== "string" || visitId.trim() === "") {
    return { ok: false, error: errorOf("MISSING_VISIT_ID", "visitId es requerido.") };
  }
  if (!isValidUuid(visitId)) {
    return { ok: false, error: errorOf("INVALID_UUID", "visitId debe ser un UUID válido.") };
  }
  return { ok: true, data: { visitId } };
}

// redeem → { rewardId }
export function validateRedeemPayload(payload) {
  if (!isRecord(payload)) {
    return { ok: false, error: errorOf("INVALID_PAYLOAD", "El cuerpo debe ser un objeto JSON.") };
  }
  const { rewardId } = payload;
  if (typeof rewardId !== "string" || rewardId.trim() === "") {
    return { ok: false, error: errorOf("MISSING_REWARD_ID", "rewardId es requerido.") };
  }
  if (!isValidUuid(rewardId)) {
    return { ok: false, error: errorOf("INVALID_UUID", "rewardId debe ser un UUID válido.") };
  }
  return { ok: true, data: { rewardId } };
}

// lookup → { token }  (token = customer_code del QR, p. ej. "SC-S4MCJPMW").
// Solo se valida formato: cadena no vacía con tope de longitud. El match
// contra customers.customer_code (o id) lo hace la Edge con service_role;
// aquí NUNCA se decide quién puede consultar (eso es decideLookupPolicy).
export function validateLookupPayload(payload) {
  if (!isRecord(payload)) {
    return { ok: false, error: errorOf("INVALID_PAYLOAD", "El cuerpo debe ser un objeto JSON.") };
  }
  const { token } = payload;
  if (typeof token !== "string" || token.trim() === "") {
    return { ok: false, error: errorOf("INVALID_TOKEN", "Código de cliente inválido.") };
  }
  if (token.length > LOOKUP_TOKEN_MAX_LENGTH) {
    return { ok: false, error: errorOf("INVALID_TOKEN", "Código de cliente inválido.") };
  }
  return { ok: true, data: { token: token.trim() } };
}

// Validación completa para una operación (campos prohibidos + payload).
export function validatePayload(operation, body) {
  const opCheck = validateOperation(operation);
  if (!opCheck.ok) return opCheck;

  if (!isRecord(body)) {
    return { ok: false, error: errorOf("INVALID_PAYLOAD", "El cuerpo debe ser un objeto JSON.") };
  }

  const actorFieldCheck = assertNoActorFields(body);
  if (!actorFieldCheck.ok) return actorFieldCheck;

  const dateFieldCheck = assertNoVisitDateField(body);
  if (!dateFieldCheck.ok) return dateFieldCheck;

  switch (operation) {
    case "visit":
      return validateVisitPayload(body);
    case "cancel":
      return validateCancelPayload(body);
    case "redeem":
      return validateRedeemPayload(body);
    case "lookup":
      return validateLookupPayload(body);
    default:
      return { ok: false, error: errorOf("INVALID_OPERATION", "Operación no válida. Use visit, cancel, redeem o lookup.") };
  }
}

// ---------------------------------------------------------------
// Fecha de negocio (timezone comercial, nunca UTC)
// ---------------------------------------------------------------
// Devuelve 'YYYY-MM-DD' correspondiente a `now` en `timezone`. NO se usa
// toISOString().slice(0,10) (eso sería UTC). Deno y Node tienen ICU
// completo, así que Intl es fiable para America/Tijuana (incl. DST).
export function getBusinessDate(now = new Date(), timezone = BUSINESS_TIMEZONE) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now debe ser una Date válida.");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => {
    const part = parts.find((p) => p.type === type);
    return part ? part.value : "00";
  };
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Guardia defensiva: la fecha de negocio derivada de `now` no puede ser
// futura. El frontend no controla la fecha, así que esto es una
// verificación de consistencia (la RPC tiene su propia barrera).
export function isFutureDate(visitDate, now = new Date(), timezone = BUSINESS_TIMEZONE) {
  const today = getBusinessDate(now, timezone);
  // Las fechas 'YYYY-MM-DD' se comparan correctamente como strings.
  return typeof visitDate === "string" && visitDate > today;
}

// ---------------------------------------------------------------
// Actor policy — QUÉ CAMBIÓ EN CHECKPOINT 1
// ---------------------------------------------------------------
// Antes: resolveActorRole() siempre devolvía 'customer' porque no
// existía identidad Staff verificable; cualquier operación staff-only
// se denegaba.
//
// Ahora: el rol se resuelve server-side desde public.profiles. La
// Edge Function (loyalty-engine/index.ts) consulta profiles con su
// cliente service_role y pasa el perfil a decideActorPolicy(). El
// core sigue siendo 100% puro (no toca Supabase): recibe el perfil
// ya resuelto.
//
// La regla sigue siendo: NUNCA confiar en un role enviado desde el
// frontend. actorId/actorRole del payload se rechazan en validación.
// resolveActorRole() no lee user_metadata ni app_metadata del JWT.

// Resuelve el rol desde el perfil real de public.profiles.
// `profile` = { id, role, name, active } obtenido server-side con
// service_role. Devuelve el rol si el perfil existe y está activo;
// null en cualquier otro caso (sin perfil, inactivo o rol inválido).
export function resolveActorRole(profile) {
  if (!profile) return null;
  if (profile.active === false) return null;
  if (profile.role === "staff" || profile.role === "admin" || profile.role === "customer") {
    return profile.role;
  }
  return null;
}

// Verifica que el actor tenga identidad Staff/Admin verificable
// (perfil activo en public.profiles). Solo este camino devuelve
// { allowed: true } para operaciones staff-only.
export function requireVerifiedStaff(profile) {
  const role = resolveActorRole(profile);
  if (role === "staff" || role === "admin") {
    return { allowed: true, actor: { actorId: profile.id, actorRole: role } };
  }
  return {
    allowed: false,
    error: errorOf("STAFF_AUTH_REQUIRED", "Se requiere una identidad Staff verificable para esta operación.", 403),
  };
}

// Denegaciones específicas para el rol customer según la operación.
const CUSTOMER_DENIALS = {
  visit: { code: "SELF_VISIT_NOT_ALLOWED", message: "Un cliente no puede registrarse su propia visita." },
  cancel: { code: "CUSTOMER_CANCEL_NOT_ALLOWED", message: "Un cliente no puede cancelar visitas." },
  redeem: { code: "CUSTOMER_REDEEM_NOT_ALLOWED", message: "Un cliente no puede redimir recompensas." },
  lookup: { code: "CUSTOMER_LOOKUP_NOT_ALLOWED", message: "Un cliente no puede consultar clientes." },
};

// Política completa: decide quién puede ejecutar cada operación.
//   { allowed: true,  actor: { actorId, actorRole } }
//   { allowed: false, error: { code, message, status } }
// `profile` es el perfil de public.profiles resuelto server-side.
export function decideActorPolicy({ operation, user, profile }) {
  if (!user || !user.id) {
    return { allowed: false, error: errorOf("UNAUTHORIZED", "Autenticación requerida.", 401) };
  }

  // Perfil ausente o inactivo → no autorizar operaciones protegidas.
  const role = resolveActorRole(profile);
  if (!role) {
    return {
      allowed: false,
      error: errorOf("PROFILE_NOT_FOUND", "No se pudo verificar tu perfil de acceso.", 403),
    };
  }

  // staff/admin con perfil activo: autorizados (verify server-side).
  if (role === "staff" || role === "admin") {
    return requireVerifiedStaff(profile);
  }

  // customer: las tres operaciones staff-only se deniegan.
  const denial = CUSTOMER_DENIALS[operation];
  if (denial) {
    return { allowed: false, error: errorOf(denial.code, denial.message, 403) };
  }
  return { allowed: false, error: errorOf("INVALID_OPERATION", "Operación no válida. Use visit, cancel, redeem o lookup.", 400) };
}

// ---------------------------------------------------------------
// Lookup policy — SOLO staff/admin activo puede consultar clientes
// ---------------------------------------------------------------
// CHECKPOINT 3.1: la consulta de clientes (lookup) es una operación
// de LECTURA staff-only. El rol se resuelve server-side desde
// public.profiles (mismo patrón que decideActorPolicy), pero con
// códigos específicos para que el frontend pueda distinguir:
//   * sin sesión        → UNAUTHORIZED 401
//   * sin perfil        → PROFILE_NOT_FOUND 403
//   * perfil inactivo   → PROFILE_INACTIVE 403 (staff desactivado)
//   * rol customer      → CUSTOMER_LOOKUP_NOT_ALLOWED 403
//   * rol staff/admin   → allowed (activo, verificado server-side)
// NUNCA se confía en user_metadata/app_metadata del JWT: el rol es
// siempre el que devuelve public.profiles vía service_role.
export function decideLookupPolicy({ user, profile }) {
  if (!user || !user.id) {
    return { allowed: false, error: errorOf("UNAUTHORIZED", "Autenticación requerida.", 401) };
  }
  if (!profile) {
    return { allowed: false, error: errorOf("PROFILE_NOT_FOUND", "No tienes permisos para consultar clientes.", 403) };
  }
  if (profile.active === false) {
    return { allowed: false, error: errorOf("PROFILE_INACTIVE", "Tu cuenta de empleado está inactiva.", 403) };
  }
  if (profile.role === "staff" || profile.role === "admin") {
    return { allowed: true, actor: { actorId: profile.id, actorRole: profile.role } };
  }
  return { allowed: false, error: errorOf("CUSTOMER_LOOKUP_NOT_ALLOWED", "Un cliente no puede consultar clientes.", 403) };
}

// ---------------------------------------------------------------
// Lookup result — forma pura del resultado de la consulta (CP3.1)
// ---------------------------------------------------------------
// Recibe los registros crudos que leyó la Edge (customers, ciclo,
// conteo de visitas activas, recompensa) y arma la respuesta de
// contrato. Es 100% puro (sin red, sin Supabase, `now` inyectable
// para probar la expiración de la recompensa).
//
// Respuesta mínima (CP3.1 + CP3.2):
//   customer { id, name, customer_code, loyverse_mapped }
//   cycle    { id, cycle_number, required_visits, active } | null
//   progress { visits, required, remaining, unlocked }      | null
//   reward   { id, status, expires_at, max_value }          | null
// La recompensa solo se devuelve si está DISPONIBLE y NO vencida;
// en cualquier otro caso (redeemed, cancelled, expirada) es null.
// `required` es SIEMPRE cycle.required_visits (fuente de verdad:
// nunca se hardcodea 7).
//
// CP3.2 — loyverse_mapped: booleano operativo derivado en SERVIDOR de la
// presencia de customers.loyverse_customer_id (la Edge selecciona esa
// columna solo para derivarlo; aquí se STRIPEA y jamás sale el id real).
// Sirve para que el Staff sepa si el receipt de Loyverse podrá asociarse
// al cliente (receipts-sync ignora customer_id sin mapeo → unmapped_customer).
export function buildLookupResult({ customer, cycle, activeVisits, reward, now = new Date() }) {
  const customerOut = customer
    ? {
        id: customer.id,
        name: customer.name || "",
        customer_code: customer.customer_code || "",
        loyverse_mapped: Boolean(customer.loyverse_customer_id),
      }
    : null;

  let cycleOut = null;
  let progressOut = null;
  let rewardOut = null;

  if (cycle) {
    cycleOut = {
      id: cycle.id,
      cycle_number: cycle.cycle_number,
      required_visits: cycle.required_visits,
      active: cycle.status === "active",
    };

    const visits = Number(activeVisits) || 0;
    const required = Number(cycle.required_visits) || 0;
    progressOut = {
      visits,
      required,
      remaining: Math.max(required - visits, 0),
      unlocked: visits >= required,
    };

    if (reward && reward.status === "available" && new Date(reward.expires_at).getTime() > now.getTime()) {
      rewardOut = {
        id: reward.id,
        status: reward.status,
        expires_at: reward.expires_at,
        max_value: reward.max_value,
      };
    }
  }

  return { customer: customerOut, cycle: cycleOut, progress: progressOut, reward: rewardOut };
}

// ---------------------------------------------------------------
// RPC mapping — argumentos EXACTOS de 0005_loyalty_engine.sql
// ---------------------------------------------------------------

// visit → register_visit(...). `actor` = { actorId, actorRole } ya
// resuelto por la política (nunca del payload). source = 'manual'
// porque esta Edge registra ventas de Staff; los receipts del POS
// (source='loyverse') llegarán por otra vía en D2.
export function buildRegisterVisitArgs(data, { visitDate, actor, source = "manual" } = {}) {
  return {
    p_customer_id: data.customerId,
    p_external_sale_id: data.externalSaleId,
    p_amount: data.amount,
    p_visit_date: visitDate,
    p_store_id: data.storeId ?? null,
    p_employee_id: data.employeeId ?? null,
    p_source: source,
    p_actor_id: actor.actorId,
    p_actor_role: actor.actorRole,
  };
}

// cancel → cancel_visit(...)
export function buildCancelVisitArgs(data, actor) {
  return {
    p_visit_id: data.visitId,
    p_actor_id: actor.actorId,
    p_actor_role: actor.actorRole,
  };
}

// redeem → redeem_reward(...)
export function buildRedeemRewardArgs(data, actor) {
  return {
    p_reward_id: data.rewardId,
    p_actor_id: actor.actorId,
    p_actor_role: actor.actorRole,
  };
}

// Despacho genérico. opts para visit: { visitDate, actor, source? };
// para cancel/redeem: { actor }.
export function buildRpcArgs(operation, data, opts = {}) {
  switch (operation) {
    case "visit":
      return buildRegisterVisitArgs(data, opts);
    case "cancel":
      return buildCancelVisitArgs(data, opts.actor);
    case "redeem":
      return buildRedeemRewardArgs(data, opts.actor);
    default:
      throw new Error(`Operación sin RPC: ${operation}`);
  }
}

// ---------------------------------------------------------------
// Errores de RPC → respuesta controlada
// ---------------------------------------------------------------
// No se exponen stack traces, ni SQL, ni details/hint de PostgREST.
// El `message` de las RPC D1.1 (raise exception ... errcode P0001) ya
// es el mensaje de negocio en español y es seguro de devolver.
export function mapRpcError(error) {
  const code = error?.code;
  const message = error?.message || "Error interno de la operación.";

  if (code === "P0001") {
    // Excepción controlada del PL/pgSQL: mensaje de negocio de la RPC.
    return { code: "RPC_REJECTED", message, status: 400 };
  }
  if (code === "42501") {
    return { code: "RPC_NOT_AUTHORIZED", message: "No autorizado para esta operación.", status: 403 };
  }
  if (code === "23505") {
    return { code: "DUPLICATE", message: "Conflicto de unicidad.", status: 409 };
  }
  if (code === "429") {
    return { code: "RATE_LIMITED", message: "Demasiadas solicitudes.", status: 429 };
  }
  return { code: "INTERNAL", message, status: 502 };
}

// ---------------------------------------------------------------
// Cuerpos de respuesta (contrato §14 del diseño D1.2)
// ---------------------------------------------------------------
export function buildResponseBody(operation, result) {
  return { ok: true, operation, result };
}

export function buildErrorResponseBody(code, message) {
  return { ok: false, error: { code, message } };
}

// ---------------------------------------------------------------
// Helpers de transporte (puros, sin I/O)
// ---------------------------------------------------------------
export function parseBearer(authHeader) {
  if (typeof authHeader !== "string") return null;
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  return token || null;
}

export function parseJsonBody(text) {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, error: errorOf("INVALID_BODY", "El cuerpo de la solicitud no es JSON válido.") };
  }
}