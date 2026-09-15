// ---------------------------------------------------------------
// ticketEmailService — "Enviar por correo" del ticket de Activity.
//
// El navegador NUNCA envía correos ni conoce credenciales SMTP.
// Delegación segura obligatoria:
//
//   React (esta función) → Supabase Edge Function `send-ticket`
//   → SMTP → correo del cliente.
//
// La Edge Function valida el JWT del usuario, verifica que el ticket
// pertenece a ese cliente (loyalty_visits) y que el correo destino
// SIEMPRE sale de GoTrue/customers (el cliente no puede elegirlo).
//
// Si la infraestructura SMTP aún no está desplegada/configurada, la
// función responde `email_not_configured` y aquí NO se simula el
// envío: la UI muestra un estado honesto de "no disponible".
// ---------------------------------------------------------------

import { supabaseClient, isSupabaseConfigured } from "../../lib/supabase/client.js";
import { readEnv } from "../../lib/utils/env.js";

export function sendTicketFunctionUrl() {
  const configuredUrl = readEnv("VITE_SEND_TICKET_FUNCTION_URL");
  if (configuredUrl) {
    return configuredUrl;
  }
  const supabaseUrl = readEnv("VITE_SUPABASE_URL");
  if (supabaseUrl) {
    return `${supabaseUrl}/functions/v1/send-ticket`;
  }
  return null;
}

// `externalSaleId` identifica el ticket (loyalty_visits.external_sale_id).
export async function sendTicketEmail({ externalSaleId }) {
  if (!isSupabaseConfigured) {
    return { ok: false, code: "email_not_configured", retriable: false };
  }

  const url = sendTicketFunctionUrl();
  if (!url) return { ok: false, code: "email_not_configured", retriable: false };

  const { data: sessionData } = await supabaseClient.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) return { ok: false, code: "unauthorized", retriable: false };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ externalSaleId }),
    });
  } catch {
    return { ok: false, code: "email_unavailable", retriable: true };
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
      code: parsed.code || "email_error",
      retriable: Boolean(parsed.retriable),
    };
  }

  return { ok: true };
}