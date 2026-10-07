// ---------------------------------------------------------------
// phoneLoginEdgeClient — única puerta del frontend hacia la Edge
// `auth-phone-login` (login y recuperación POR TELÉFONO).
//
// El navegador manda teléfono + contraseña (u OTP) y recibe SOLO los
// tokens de sesión que emite Supabase Auth, o un código de error
// genérico. Nunca recibe el email de la cuenta (antes lo obtenía de la
// RPC resolve_email_for_login, que desde 0020 es solo de service_role).
// ---------------------------------------------------------------

import { readEnv } from "../../lib/utils/env.js";

export function authPhoneLoginFunctionUrl() {
  const configuredUrl = readEnv("VITE_AUTH_PHONE_LOGIN_FUNCTION_URL");
  if (configuredUrl) return configuredUrl;
  const supabaseUrl = readEnv("VITE_SUPABASE_URL");
  if (supabaseUrl) return `${supabaseUrl}/functions/v1/auth-phone-login`;
  return null;
}

// payload = { operation: "password" | "recover_start" | "recover_verify",
//             phone, password?, code? }
// → { ok: true, session? } | { ok: false, code, retriable }
export async function callPhoneLogin(payload) {
  const url = authPhoneLoginFunctionUrl();
  if (!url) return { ok: false, code: "network_error", retriable: true };

  const headers = { "Content-Type": "application/json" };
  const publishableKey = readEnv("VITE_SUPABASE_PUBLISHABLE_KEY");
  if (publishableKey) headers.apikey = publishableKey;

  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  } catch {
    return { ok: false, code: "network_error", retriable: true };
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const parsed = body || {};

  if (!res.ok || parsed.ok !== true) {
    return { ok: false, code: parsed.code || "network_error", retriable: Boolean(parsed.retriable) };
  }
  return { ok: true, session: parsed.session || null };
}
