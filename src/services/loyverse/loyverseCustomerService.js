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
// ---------------------------------------------------------------

import { linkCustomer } from "./loyverseEdgeClient.js";

function normalizeResult(result) {
  if (result.ok) {
    return { status: result.status, loyverseCustomerId: result.loyverseCustomerId };
  }
  if (result.code === "loyverse_customer_conflict" || result.code === "loyverse_identity_conflict") {
    return { status: "conflict", error: result.code };
  }
  return { status: "failed", error: result.code || "loyverse_unavailable", retriable: result.retriable };
}

export async function createOrLinkLoyverseCustomer(profile) {
  const result = await linkCustomer({
    name: profile.name,
    email: profile.email || null,
    phone: profile.phone || null,
    customerCode: profile.customer_code,
  });
  return normalizeResult(result);
}

export async function retryLoyverseSync(profile) {
  return createOrLinkLoyverseCustomer(profile);
}