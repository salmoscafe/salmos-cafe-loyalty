// ---------------------------------------------------------------
// send-ticket — Edge Function segura para "Enviar por correo" (ticket
// de Activity → correo del cliente).
//
// Pipeline:
//   Activity (React) → esta función (JWT del usuario) → verificación
//   de propiedad del ticket → plantilla Salmos con datos reales → SMTP
//   → correo del cliente.
//
// Seguridad:
//   * verify_jwt = true (supabase/config.toml): exige sesión GoTrue.
//   * El correo destino SIEMPRE sale de GoTrue/customers (user.email o
//     customers.email). El payload del cliente NUNCA pauta el correo.
//   * El ticket se verifica como propio: loyalty_visits scoped por
//     customer_id del usuario autenticado + external_sale_id exacto
//     (RLS del cliente, sin service_role).
//   * Las credenciales SMTP (SMTP_HOST/PORT/USER/PASS/SENDER_*) viven
//     solo en el servidor. Jamás VITE_*, jamás en el bundle.
//   * Si el SMTP no está configurado → email_not_configured, NO se
//     simula el envío.
//
// Despliegue: supabase functions deploy send-ticket
// Vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//       SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SENDER_EMAIL,
//       SMTP_SENDER_NAME, SMTP_APP_URL (opcional, solo para el CTA)
// ---------------------------------------------------------------
//
// [SMTP_PENDIENTE] El transporte usa nodemailer (npm:nodemailer@^9, el
// ejemplo oficial de Supabase: supabase/examples/edge-functions/send-email-smtp).
// Se sustituyó deno.land/x/smtp@v0.7.0 porque usa APIs Deno 1.x obsoletas
// (Deno.writeAll/readAll) → "Deno.writeAll is not a function" en el runtime
// actual de Edge Functions. Gmail se conecta con implicit TLS (secure) en 465.
//   * Pendiente real (externo): dominio + SPF/DKIM/DMARC y la contraseña
//     de aplicación de Gmail (ver config.toml §auth.email.smtp).

import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@^9";
import { computeCycleVisitProgress, renderTicketEmail } from "../_shared/ticketEmail.js";
import { resolveSmtpPort } from "../_shared/smtpConn.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function safeDetail(value) {
  const text = String(value || "");
  return text.slice(0, 500);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed", retriable: false }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!supabaseUrl || !supabaseAnonKey) {
    return json({ ok: false, code: "srv_not_configured", retriable: true }, 503);
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return json({ ok: false, code: "unauthorized", retriable: false }, 401);

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user) return json({ ok: false, code: "unauthorized", retriable: false }, 401);

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, code: "invalid_body", retriable: false }, 400);
    }
    const externalSaleId = String(body?.externalSaleId || "").trim();
    if (!externalSaleId) {
      return json({ ok: false, code: "missing_ticket", retriable: false }, 400);
    }

    const { data: profile } = await supabase
      .from("customers")
      .select("id, email")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    if (!profile) return json({ ok: false, code: "customer_setup_required", retriable: false }, 409);

    // Correo destino: SIEMPRE la identidad verificada (GoTrue primero,
    // customers como respaldo). El payload no puede cambiarlo (C4).
    const email = user.email || profile.email || null;
    if (!email) return json({ ok: false, code: "no_email", retriable: false }, 409);

    // Solo el propio ticket (RLS del cliente + scope explícito).
    const { data: visit } = await supabase
      .from("loyalty_visits")
      .select("*")
      .eq("customer_id", profile.id)
      .eq("external_sale_id", externalSaleId)
      .maybeSingle();
    if (!visit) return json({ ok: false, code: "ticket_not_found", retriable: false }, 404);

    // Progreso del ciclo (mismo dato que el ticket de la app: derive de
    // loyalty_visits, el esquema real no guarda contador). Si no se puede
    // calcular, el correo simplemente omite la línea "Tu tarjeta N/M".
    let cycleVisits = null;
    let requiredVisits = null;
    {
      const { data: allVisits } = await supabase
        .from("loyalty_visits")
        .select("id, cycle_id, status, receipt_date, visit_date, created_at")
        .eq("customer_id", profile.id);
      const progressMap = computeCycleVisitProgress(allVisits || []);
      cycleVisits = progressMap.get(visit.id) ?? null;

      const { data: cycles } = await supabase
        .from("loyalty_cycles")
        .select("id, required_visits")
        .eq("customer_id", profile.id);
      const cycle = (cycles || []).find((c) => c.id === visit.cycle_id);
      requiredVisits = typeof cycle?.required_visits === "number" ? cycle.required_visits : null;
    }

    // Sin SMTP no se simula el envío: se responde email_not_configured.
    const smtpHost = Deno.env.get("SMTP_HOST") || "";
    // Gmail: implicit TLS en 465 (SMTP_PORT=465). Si el puerto fuera 587,
    // nodemailer usaría STARTTLS de forma automática; la config del proyecto
    // y los secretos remotos apuntan a 465 (secure=true).
    const smtpPort = resolveSmtpPort(Deno.env.get("SMTP_PORT"));
    const smtpUser = Deno.env.get("SMTP_USER") || "";
    const smtpPass = Deno.env.get("SMTP_PASS") || "";
    const senderEmail = Deno.env.get("SMTP_SENDER_EMAIL") || "";
    const senderName = Deno.env.get("SMTP_SENDER_NAME") || "Salmos Café";

    if (!smtpHost || !smtpUser || !smtpPass || !senderEmail) {
      return json(
        {
          ok: false,
          code: "email_not_configured",
          retriable: false,
          message: "El envío por correo todavía no está configurado en el servidor.",
        },
        503
      );
    }

    const subject = "Tu ticket de Salmos Café";
    const appUrl = Deno.env.get("SMTP_APP_URL") || "";
    const content = renderTicketEmail({ visit, cycleVisits, requiredVisits, appUrl });

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465, // implicit TLS (Gmail). 587 → STARTTLS automático.
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });
    try {
      await transporter.sendMail({
        from: senderName ? `${senderName} <${senderEmail}>` : senderEmail,
        to: [email],
        subject,
        html: content,
      });
      transporter.close();
    } catch (error) {
      // Diagnóstico temporal (seguro): en Supabase Function Logs se verá el
      // nombre y el mensaje del error SMTP, SIN exponer credenciales, tokens
      // ni datos personales del cliente. El mensaje se sanitiza removiendo
      // SMTP_USER/SMTP_PASS por si el cliente SMTP los incluyera.
      let safeMessage = error instanceof Error
        ? error.message
        : String(
            error && typeof error === "object" && "message" in error ? error.message : error) || "unknown";
      if (smtpUser) safeMessage = safeMessage.split(smtpUser).join("[REDACTED_USER]");
      if (smtpPass) safeMessage = safeMessage.split(smtpPass).join("[REDACTED_PASS]");
      console.error("[send-ticket] SMTP error", {
        name: error instanceof Error ? error.name : typeof error,
        message: safeMessage,
      });
      // Nunca exponer credenciales ni detalles SMTP al navegador.
      return json({ ok: false, code: "email_send_failed", retriable: true }, 502);
    }

    return json({ ok: true, externalSaleId });
  } catch (error) {
    return json({ ok: false, code: "internal_error", retriable: true }, 500);
  }
});