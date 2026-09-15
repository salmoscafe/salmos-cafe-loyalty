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
//       SMTP_SENDER_NAME
// ---------------------------------------------------------------
//
// [SMTP_PENDIENTE] El cliente SMTP es un import de deno.land/x/smtp
// (0.7.0, puro Deno). Si al desplegar el CLI no lo puede empaquetar,
// sustituir por el proveedor que se use y NO tocar el resto del flujo.
// Estado: el diseño HTML del correo y la verificación de propiedad ya
// están listos; solo falta el transporte SMTP real (proveedor + dominio
// + SPF/DKIM/DMARC, ver config.toml §auth.email.smtp).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { SmtpClient } from "https://deno.land/x/smtp@v0.7.0/mod.ts";

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

function formatMoney(amount) {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: Number.isInteger(Number(amount)) ? 0 : 2,
  }).format(Number(amount || 0));
}

function formatWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const datePart = d.toLocaleDateString("es-MX", { day: "numeric", month: "long" });
  const timePart = d.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit" });
  return `${datePart} · ${timePart}`;
}

function buildTicketEmailHtml(visit) {
  const isCancelled = visit.status === "cancelled";
  const hasReward = Boolean(visit.triggered_reward_id);
  const ref =
    typeof visit.external_sale_id === "string" && visit.external_sale_id !== ""
      ? visit.external_sale_id.split("_").pop()
      : visit.id;
  const when = formatWhen(visit.receipt_date || visit.created_at);
  const total = formatMoney(visit.amount);
  const items = Array.isArray(visit.items) && visit.items.length > 0 ? visit.items : null;

  const itemRows = (items || [])
    .map(
      (item, idx) =>
        `<tr>
           <td style="padding:8px 24px; border-bottom:1px solid rgba(16,15,15,0.08);">
             <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
               <tr>
                 <td style="font-family:'IBM Plex Mono',Courier,monospace; font-size:13px; color:#100F0F;">${String(item.quantity || 1)} ${String(item.name || "Artículo")}</td>
                 <td align="right" style="font-family:'IBM Plex Mono',Courier,monospace; font-size:13px; color:#100F0F;">${formatMoney(item.total ?? item.unit_price * (item.quantity || 1))}</td>
               </tr>
             </table>
           </td>
         </tr>`
    )
    .join("");

  const rewardRow = hasReward
    ? `<tr>
         <td style="padding:12px 24px; border-bottom:1px solid rgba(16,15,15,0.08);">
           <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:bold; color:#8a6a26; text-align:center; background:rgba(201,162,75,0.14); border-radius:8px; padding:8px 10px;">RECOMPENSA GENERADA</p>
         </td>
       </tr>`
    : "";

  const row = (label, value, bold = false) =>
    `<tr>
       <td style="padding:9px 24px; border-bottom:1px solid rgba(16,15,15,0.08);">
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
           <tr>
             <td style="font-family:'IBM Plex Mono',Courier,monospace; font-size:13px; color:rgba(16,15,15,0.62); white-space:nowrap;">${label}</td>
             <td align="right" style="font-family:'IBM Plex Mono',Courier,monospace; font-size:13px; color:#100F0F; ${bold ? "font-weight:bold; font-size:15px;" : ""}">${value}</td>
           </tr>
         </table>
       </td>
     </tr>`;

  return `<!doctype html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Tu ticket de Salmos Café</title>
</head>
<body style="margin:0; padding:0; background-color:#F5EEE2; -webkit-text-size-adjust:100%;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#F5EEE2;">
    Aquí tienes el detalle de tu visita.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5EEE2;">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px; background-color:#FFFFFF; border-radius:16px; overflow:hidden;">

          <tr>
            <td align="center" style="background-color:#1F3355; padding:32px 24px;">
              <!-- [LOGO_URL_PROVISIONAL] misma convención que las plantillas existentes de email-templates/. -->
              <img src="https://raw.githubusercontent.com/salmoscafe/salmos-cafe-loyalty/main/email-templates/assets/wordmark-cream.png" width="180" height="58" alt="Salmos Café" style="display:block; border:0;">
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:38px 32px 8px;">
              <h1 style="margin:0 0 10px; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-weight:normal; font-size:26px; line-height:1.25; color:#1F3355;">
                Tu ticket de Salmos Café
              </h1>
              <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:1.6; color:#100F0F;">
                Aquí tienes el detalle de tu visita.
              </p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:24px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FBF7EF; border-radius:12px; overflow:hidden; border:1px solid rgba(16,15,15,0.08);">

                <tr>
                  <td align="center" style="padding:18px 24px 6px;">
                    <p style="margin:0; font-family:'IBM Plex Mono',Courier,monospace; font-size:14px; font-weight:bold; letter-spacing:0.08em; color:#1F3355;">SALMOS CAFÉ</p>
                    <p style="margin:4px 0 0; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:11px; color:#33211D;">Donde el café es un verso al paladar</p>
                  </td>
                </tr>

                <tr>
                  <td style="padding:12px 24px 0; text-align:center;">
                    <p style="margin:0; font-family:'IBM Plex Mono',Courier,monospace; font-size:12px; color:#100F0F; line-height:1.6;">
                      Ticket #${ref}<br>${when}
                    </p>
                  </td>
                </tr>

                <tr>
                  <td style="padding:12px 24px 0;">
                    <div style="border-top:1px dashed rgba(16,15,15,0.25);"></div>
                  </td>
                </tr>

                ${itemRows}

                ${row("Total", total, true)}

                ${row("Estado", isCancelled ? "Compra cancelada" : "Compra registrada")}

                ${rewardRow}

              </table>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:0 32px 36px;">
              <p style="margin:0 0 6px; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:14px; color:#33211D;">
                Salmos Café
              </p>
              <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:11px; color:#33211D; opacity:0.55; line-height:1.5;">
                Gracias por tu visita: cada café suma en tu tarjeta.
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
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

    // Sin SMTP no se simula el envío: se responde email_not_configured.
    const smtpHost = Deno.env.get("SMTP_HOST") || "";
    const smtpPort = Number(Deno.env.get("SMTP_PORT") || 587);
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
    const content = buildTicketEmailHtml(visit);

    const client = new SmtpClient();
    try {
      await client.connectTLS({
        hostname: smtpHost,
        port: smtpPort,
        username: smtpUser,
        password: smtpPass,
      });
      await client.send({
        from: senderName ? `${senderName} <${senderEmail}>` : senderEmail,
        to: [email],
        subject,
        content,
        html: content,
      });
      await client.close();
    } catch (error) {
      // Nunca exponer credenciales ni detalles SMTP al navegador.
      return json({ ok: false, code: "email_send_failed", retriable: true }, 502);
    }

    return json({ ok: true, externalSaleId });
  } catch (error) {
    return json({ ok: false, code: "internal_error", retriable: true }, 500);
  }
});