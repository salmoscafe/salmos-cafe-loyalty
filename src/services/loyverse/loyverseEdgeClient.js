// ---------------------------------------------------------------
// loyverseEdgeClient — ÚNICA puerta del frontend hacia Loyverse, y
// DELEGA en la Edge Function segura. El navegador NUNCA llama a
// https://api.loyverse.com/... y NUNCA ve LOYVERSE_ACCESS_TOKEN.
//
// La Edge Function se autentica con el JWT del usuario (Authorization
// header) y es la dueña del token de Loyverse (lado servidor).
// ---------------------------------------------------------------

import { supabaseClient, isSupabaseConfigured } from "../../lib/supabase/client.js";
import { readEnv } from "../../lib/utils/env.js";

export function loyverseCustomersFunctionUrl() {
  const configuredUrl = readEnv("VITE_LOYVERSE_CUSTOMERS_FUNCTION_URL");
  if (configuredUrl) {
    return configuredUrl;
  }
  const supabaseUrl = readEnv("VITE_SUPABASE_URL");
  if (supabaseUrl) {
    return `${supabaseUrl}/functions/v1/loyverse-customers`;
  }
  return null;
}

// `payload` = { name, email, phone, customerCode }
export async function linkCustomer(payload) {
  if (!isSupabaseConfigured) {
    // Modo demo: no hay Loyverse real detrás.
    return { ok: true, status: "skipped", loyverseCustomerId: null };
  }
  const url = loyverseCustomersFunctionUrl();
  if (!url) return { ok: false, code: "loyverse_unavailable", retriable: true };

  const { data: sessionData } = await supabaseClient.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) return { ok: false, code: "unauthorized" };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation: "link_or_create", ...payload }),
    });
  } catch {
    return { ok: false, code: "loyverse_unavailable", retriable: true };
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
      code: parsed.code || "loyverse_error",
      traceId: parsed.traceId,
      retriable: Boolean(parsed.retriable),
    };
  }

  return {
    ok: true,
    status: parsed.status,
    loyverseCustomerId: parsed.loyverseCustomerId,
  };
}