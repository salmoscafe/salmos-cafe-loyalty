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
//   * La Edge NO duplica reglas de negocio ($50, 1 visita/día, 8ª
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
export const OPERATIONS = Object.freeze(["visit", "cancel", "redeem"]);

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
    return { ok: false, error: errorOf("INVALID_OPERATION", "Operación no válida. Use visit, cancel o redeem.") };
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
    default:
      return { ok: false, error: errorOf("INVALID_OPERATION", "Operación no válida. Use visit, cancel o redeem.") };
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
// Actor policy — MUY IMPORTANTE
// ---------------------------------------------------------------
// No existe identidad Staff verificable en el sistema (no hay tabla
// `staff`, no hay auth Staff). Todo usuario autenticado de Supabase
// Auth es un cliente. La Edge NUNCA confía en actorRole/actorId del
// payload (los rechaza en validación).

// Único punto de evolución cuando exista Staff real. Hoy devuelve
// 'customer' para cualquier usuario autenticado.
export function resolveActorRole() {
  return "customer";
}

// NO inventar identidad: cualquier operación que requiera Staff se
// deniega hasta que exista un mecanismo de auth Staff verificable.
export function requireVerifiedStaff() {
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
};

// Política completa: decide quién puede ejecutar cada operación.
//   { allowed: true,  actor: { actorId, actorRole } }
//   { allowed: false, error: { code, message, status } }
export function decideActorPolicy({ operation, user }) {
  if (!user || !user.id) {
    return { allowed: false, error: errorOf("UNAUTHORIZED", "Autenticación requerida.", 401) };
  }

  const role = resolveActorRole(user);

  if (role === "staff") {
    // A futuro: un rol staff solo pasa si hay identidad verificable.
    return requireVerifiedStaff(user);
  }

  // Hoy cualquier usuario autenticado es customer → las tres operaciones
  // (todas staff-only) se deniegan con su código específico.
  const denial = CUSTOMER_DENIALS[operation];
  if (denial) {
    return { allowed: false, error: errorOf(denial.code, denial.message, 403) };
  }
  return { allowed: false, error: errorOf("INVALID_OPERATION", "Operación no válida. Use visit, cancel o redeem.", 400) };
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