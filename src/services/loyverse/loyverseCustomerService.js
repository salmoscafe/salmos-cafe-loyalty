// ---------------------------------------------------------------
// loyverseCustomerService — abstracción aislada que usa el resto de
// la app (authService) para sincronizar al cliente Salmos con un
// cliente de Loyverse.
//
//   createOrLinkLoyverseCustomer(profile)
//     → { status: "synced"|"failed"|"conflict", ... }
//
// (internamente la Edge Function puede devolver `created | linked |
// updated | already_linked | conflict`; `updated` se mapea a `synced`
// en supabaseAuthService, aquí solo se pasan los status de éxito.)
//
// La lógica de decisión (buscar por email/teléfono, no duplicar,
// caso de conflicto, idempotencia) vive del lado servidor en la Edge
// Function (`supabase/functions/_shared/loyverseCore.js`). Aquí solo
// se invoca el endpoint seguro y se normaliza el estado para la UI.
//
// NUNCA hay fetch directo a api.loyverse.com ni token en este código.
//
// Guard "single-flight": la búsqueda+creación remota no es atómica, así
// que SIEMPRE se colapsa a una sola llamada activa por sesión de app.
// Si buildSession (sync automático) y el Retry del SyncBanner se
// solapan, la segunda llamada comparte la misma promesa de la primera
// (no dispara otra búsqueda+creación → sin clientes Loyverse duplicados).
// ---------------------------------------------------------------

import { linkCustomer } from "./loyverseEdgeClient.js";
import { coalesce, isSingleFlightActive } from "./singleFlight.js";

function normalizeResult(result) {
  if (result.ok) {
    return { status: result.status, loyverseCustomerId: result.loyverseCustomerId };
  }
  if (result.code === "loyverse_customer_conflict" || result.code === "loyverse_identity_conflict") {
    return { status: "conflict", error: result.code };
  }
  return { status: "failed", error: result.code || "loyverse_unavailable", retriable: result.retriable };
}

async function callLinkCustomer(profile) {
  const result = await linkCustomer({
    name: profile.name,
    email: profile.email || null,
    phone: profile.phone || null,
    customerCode: profile.customer_code,
  });
  return normalizeResult(result);
}

export function createOrLinkLoyverseCustomer(profile) {
  // Idempotencia local: ya vinculado y sin peticiones en curso → no hay
  // red ni single-flight (los reintentos del arranque no hacen nada).
  if (profile.loyverse_customer_id && profile.loyverse_sync_status === "synced") {
    return Promise.resolve({
      status: "already_synced",
      loyverseCustomerId: profile.loyverse_customer_id,
    });
  }
  return coalesce(() => callLinkCustomer(profile));
}

export function retryLoyverseSync(profile) {
  return createOrLinkLoyverseCustomer(profile);
}

export function isSyncInFlight() {
  return isSingleFlightActive();
}