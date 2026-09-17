// ---------------------------------------------------------------
// loyaltyEdgeClient — única puerta del frontend hacia la Edge Function
// `loyalty-engine`, para las operaciones reales que hoy están
// soportadas:
//   * `lookup` — Customer Lookup real (CP3.1): cliente por token de QR.
//   * `redeem` — canje de recompensa real (rewardService.redeemReward):
//     { operation: "redeem", rewardId }.
//
// Seguridad:
//   * Se autentica con el JWT de la sesión (Authorization header); la
//     Edge revalida la sesión con auth.getUser y resuelve el rol/actor
//     desde public.profiles con service_role (lado servidor). El
//     frontend jamás ve la clave de servicio (service_role).
//   * El actor y su rol NO viajan en el payload: la Edge los fuerza
//     server-side. El frontend nunca envía actorId ni actorRole;
//     role='customer' desde el cliente es rechazado.
// ---------------------------------------------------------------

import { supabaseClient, isSupabaseConfigured } from "../../lib/supabase/client.js";
import { readEnv } from "../../lib/utils/env.js";

export function loyaltyEngineFunctionUrl() {
  const configuredUrl = readEnv("VITE_LOYALTY_ENGINE_FUNCTION_URL");
  if (configuredUrl) {
    return configuredUrl;
  }
  const supabaseUrl = readEnv("VITE_SUPABASE_URL");
  if (supabaseUrl) {
    return `${supabaseUrl}/functions/v1/loyalty-engine`;
  }
  return null;
}

// `payload` = { operation: 'lookup', token: 'SC-XXXXXXXX' }
//          o { operation: 'redeem', rewardId: '<uuid>' }.
export async function callLoyaltyEdge(payload) {
  if (!isSupabaseConfigured) {
    return { ok: false, code: "loyalty_unavailable", retriable: true };
  }
  const url = loyaltyEngineFunctionUrl();
  if (!url) return { ok: false, code: "loyalty_unavailable", retriable: true };

  const {
    data: { session },
  } = await supabaseClient.auth.getSession();
  const token = session?.access_token;
  if (!token) return { ok: false, code: "unauthorized", message: "Tu sesión expiró." };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, code: "loyalty_unavailable", retriable: true, message: "No pudimos conectar con el servidor." };
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const parsed = body || {};

  if (!res.ok) {
    return {
      ok: false,
      code: parsed.code || "loyalty_error",
      message: parsed.message || "La operación no se pudo completar.",
      retriable: Boolean(parsed.retriable),
    };
  }

  return { ok: true, ...parsed };
}