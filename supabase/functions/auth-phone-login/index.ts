// ---------------------------------------------------------------
// Edge Function: auth-phone-login
//
// Login y recuperación de contraseña POR TELÉFONO sin revelar el email
// al navegador. Sustituye la llamada directa (anon) a la RPC
// resolve_email_for_login, que devolvía el email de cualquier teléfono.
//
//   POST { operation: "password",       phone, password }
//        → 200 { ok, session: { access_token, refresh_token, ... } }
//   POST { operation: "recover_start",  phone }
//        → 200 { ok }   (siempre igual, exista o no la cuenta)
//   POST { operation: "recover_verify", phone, code }
//        → 200 { ok, session } | 401 otp_invalid
//
// Seguridad:
//   * verify_jwt = false (config.toml): se usa ANTES de tener sesión.
//   * El teléfono se resuelve a email con la secret key (service_role)
//     vía public.resolve_email_for_login (0020: solo service_role).
//   * GoTrue valida la contraseña / el OTP. La llamada usa la secret key
//     + `Sb-Forwarded-For` con la IP del cliente para que el rate limit
//     de Auth (/token, /otp, /verify) siga siendo POR IP REAL del
//     usuario y no de la Edge. Requiere activar "IP Address Forwarding"
//     en Authentication → Rate Limits (ver docs/ y el reporte).
//   * Nunca se responde ni se registra en logs el email, la contraseña
//     ni el OTP. Errores genéricos (sin oráculo de existencia): ver
//     _shared/authPhoneLoginCore.js.
// ---------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { readDefaultKey } from "../_shared/supabaseKeys.js";
import { clientIpFrom, handlePhoneLogin } from "../_shared/authPhoneLoginCore.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed", retriable: false }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const secretKey = readDefaultKey(Deno.env.get("SUPABASE_SECRET_KEYS"));
  if (!supabaseUrl || !secretKey) {
    return json({ ok: false, code: "service_unavailable", retriable: true }, 503);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, code: "invalid_request", retriable: false }, 400);
  }

  const clientIp = clientIpFrom(req.headers);
  const clientOptions = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  };
  // Lookup interno (RPC solo service_role).
  const serviceClient = createClient(supabaseUrl, secretKey, clientOptions);
  // Cliente para GoTrue con la IP real del usuario (rate limit por IP).
  const authClient = createClient(supabaseUrl, secretKey, {
    ...clientOptions,
    global: { headers: clientIp ? { "sb-forwarded-for": clientIp } : {} },
  });

  try {
    const result = await handlePhoneLogin(body, {
      async resolveEmail(phone: string) {
        const { data, error } = await serviceClient.rpc("resolve_email_for_login", { p_identifier: phone });
        if (error) throw new Error("lookup_failed");
        return typeof data === "string" && data ? data : null;
      },
      async signInWithPassword(email: string, password: string) {
        const { data, error } = await authClient.auth.signInWithPassword({ email, password });
        return { session: data?.session ?? null, error };
      },
      async sendOtp(email: string) {
        const { error } = await authClient.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
        return { error };
      },
      async verifyOtp(email: string, code: string) {
        const { data, error } = await authClient.auth.verifyOtp({ email, token: code, type: "email" });
        return { session: data?.session ?? null, error };
      },
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      randomId: () => crypto.randomUUID(),
    });
    return json(result.body, result.status);
  } catch {
    return json({ ok: false, code: "service_unavailable", retriable: true }, 503);
  }
});
