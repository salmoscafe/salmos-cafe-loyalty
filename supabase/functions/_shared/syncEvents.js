// ---------------------------------------------------------------
// customer_sync_events — único writer (Fase 2A, migración 0026).
//
// Lo usa loyverse-customers SIEMPRE con el cliente service_role: desde
// 0026 el cliente autenticado solo puede LEER sus propios eventos (no
// INSERT/UPDATE/DELETE), así que un evento en la tabla proviene del
// backend.
//
// Formato de la fila: idéntico al histórico de logSyncEvent. El traceId
// lo genera el servidor (crypto.randomUUID en la Edge) y prevalece sobre
// cualquier `traceId` que traiga `detail`.
//
// Manejo de fallos (Opción A del diseño): un fallo al registrar el evento
// NUNCA hace fallar la operación principal ni cambia la respuesta HTTP.
// supabase-js no lanza: devuelve { error }. Se revisa explícitamente y,
// además, se captura cualquier excepción. El fallo queda observable en los
// logs de la función con un registro técnico mínimo: traceId, eventType,
// authUserId y el código del error. Nunca se registran `detail`,
// error.message ni datos de contacto.
// ---------------------------------------------------------------

export const SYNC_EVENTS_TABLE = "customer_sync_events";
export const SYNC_EVENT_INSERT_FAILED = "customer_sync_event_insert_failed";

export function buildSyncEventRow({ authUserId, traceId, eventType, detail }) {
  return {
    auth_user_id: authUserId,
    trace_id: traceId,
    event_type: eventType,
    detail: { ...detail, traceId },
  };
}

// Solo códigos cortos (SQLSTATE / PostgREST): nunca un objeto ni un texto
// libre que pudiera arrastrar valores.
function safeErrorCode(code) {
  if (typeof code === "string" || typeof code === "number") {
    return String(code).slice(0, 32);
  }
  return null;
}

function defaultLogger(entry) {
  console.error(JSON.stringify(entry));
}

// Devuelve { ok: true } o { ok: false, code }. Nunca lanza.
export async function recordSyncEvent(client, event, { logger = defaultLogger } = {}) {
  let code = null;
  try {
    const result = await client.from(SYNC_EVENTS_TABLE).insert(buildSyncEventRow(event));
    if (!result?.error) return { ok: true };
    code = safeErrorCode(result.error.code);
  } catch (error) {
    code = safeErrorCode(error?.code);
  }
  try {
    logger({
      event: SYNC_EVENT_INSERT_FAILED,
      traceId: event?.traceId ?? null,
      eventType: event?.eventType ?? null,
      authUserId: event?.authUserId ?? null,
      code,
    });
  } catch {
    // El registro del fallo tampoco puede romper la operación principal.
  }
  return { ok: false, code };
}
