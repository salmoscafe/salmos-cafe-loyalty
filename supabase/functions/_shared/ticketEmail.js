// ---------------------------------------------------------------
// ticketEmail — renderer del correo "Tu ticket de Salmos Café"
// (send-ticket). El TICKET DE LA APP (ReceiptPrinter) es la fuente de
// verdad: este módulo lo espeja en HTML compatible con correo (tablas,
// estilos inline, sin JS).
//
// Espejos (verificados por tests/send-ticket-email.test.mjs contra lo
// que corre en el cliente):
//   * money()                    → ReceiptPrinter.money (no .00)
//   * formatReceiptWhenForEmail  → src/lib/format.js + TZ America/Tijuana
//   * computeCycleVisitProgress  → salesService.computeCycleProgress
//   * verse                      → ticketEmailVerses.js (mismo pool 49)
//   * barcode                    → ticketEmailCode128.js (mismo Code 128)
//
// El correo usa SOLO datos reales de loyalty_visits; el HTML contiene
// el mismo estado base que el ticket (activa+recompensa, activa sin
// recompensa, cancelada) con los mismos textos.
//
// Composición impresora→ticket (copia la puesta en escena de
// ReceiptPrinter.jsx + styles.css): impresora navy grande detrás con
// ranura/LED/logotipo, y el ticket saliendo por debajo superpuesto
// parcialmente (margin negativo + z-index), igual que .sc-printer/
// .sc-receipt-wrap. Compatible con Gmail (tablas + inline styles + mso
// guard); si un cliente ignora z-index, el ticket se ve sin superposición.
// ---------------------------------------------------------------

import {
  resolveTicketPassageForEmail,
} from "./ticketEmailVerses.js";
import {
  code128ValueFor,
  encodeCode128,
  folioFor,
} from "./ticketEmailCode128.js";

// ---------------------------------------------------------------
// Espejos del formato del ticket
// ---------------------------------------------------------------

// Precio del ticket: enteros sin .00 ("$120"), decimales con 2 cifras
// ("$59.99"). Nunca moneda localizada: es un recibo de POS.
export function money(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "$0";
  return "$" + v.toFixed(2).replace(/\.00$/, "");
}

// Fecha/hora del recibo: "14 Sep 2026 · 09:00" (igual que el ticket),
// siempre en la zona horaria del negocio (America/Tijuana) sea cual
// sea la zona del servidor.
export function formatReceiptWhenForEmail(isoString, timeZone = "America/Tijuana") {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return String(isoString || "");
  const datePart = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone });
  const timePart = d.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit", hour12: false, timeZone });
  return `${datePart} · ${timePart}`;
}

// Progreso histórico por visita dentro de su ciclo (cuántas visitas
// ACTIVAS había al momento de la visita, incluyéndola). Espejo exacto
// de salesService.computeCycleProgress (se deriva de loyalty_visits,
// el esquema real no guarda contador). Devuelve un Map id → progreso.
export function computeCycleVisitProgress(visits) {
  const byCycle = new Map();
  for (const visit of visits) {
    const list = byCycle.get(visit.cycle_id) || [];
    list.push(visit);
    byCycle.set(visit.cycle_id, list);
  }

  const progressByVisit = new Map();
  for (const list of byCycle.values()) {
    const ordered = [...list].sort((a, b) => {
      const ta = new Date(a.receipt_date ?? a.visit_date ?? a.created_at).getTime();
      const tb = new Date(b.receipt_date ?? b.visit_date ?? b.created_at).getTime();
      return ta - tb || (a.created_at ? a.created_at.localeCompare(b.created_at || "") : 0);
    });
    let running = 0;
    for (const visit of ordered) {
      if (visit.status === "active") running += 1;
      progressByVisit.set(visit.id, running);
    }
  }
  return progressByVisit;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}

// ---------------------------------------------------------------
// Barcos del barcode real (Code 128) en HTML de correo: una celda por
// "trazo" (barra o espacio), ancho = módulos × módulo usado, con zona
// de silencio. El número legible se dibuja aparte con el MISMO valor.
// ---------------------------------------------------------------
function code128BarsHtml(encoded, { moduleWidth = 2, barHeight = 34, quiet = 8 } = {}) {
  const modules = encoded.modules;
  const quietPx = Math.max(0, Math.round(Number(quiet) || 0)) * moduleWidth;
  const totalPx = (modules.length * moduleWidth) + quietPx * 2;

  let html = `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="width:${totalPx}px; border-collapse:collapse;">
    <tr>
      <td width="${quietPx}" style="width:${quietPx}px; font-size:0; line-height:0; padding:0;">&nbsp;</td>`;

  let i = 0;
  while (i < modules.length) {
    const bit = modules[i];
    let j = i;
    while (j < modules.length && modules[j] === bit) j += 1;
    const widthPx = (j - i) * moduleWidth;
    const barStyle = bit === 1 ? "background-color:#101010;" : "";
    html += `
      <td width="${widthPx}" style="width:${widthPx}px; height:${barHeight}px; font-size:0; line-height:0; padding:0; ${barStyle}">&nbsp;</td>`;
    i = j;
  }

  html += `
      <td width="${quietPx}" style="width:${quietPx}px; font-size:0; line-height:0; padding:0;">&nbsp;</td>
    </tr>
  </table>`;
  return html;
}

// ---------------------------------------------------------------
// Renderer principal
// ---------------------------------------------------------------
export function renderTicketEmail({ visit = {}, cycleVisits = null, requiredVisits = null, appUrl = "" } = {}) {
  const isActive = visit.status === "active" || visit.status === "completed";
  const hasReward = isActive && Boolean(visit.triggered_reward_id);
  const hasProgress =
    cycleVisits != null &&
    requiredVisits != null &&
    Number.isFinite(Number(cycleVisits)) &&
    Number.isFinite(Number(requiredVisits));

  const ticketRef = folioFor(visit) || String(visit.external_sale_id || "") || String(visit.id || "");
  const when = formatReceiptWhenForEmail(visit.receipt_date || visit.created_at);
  const total = money(visit.amount);

  const items = Array.isArray(visit.items) && visit.items.length > 0 ? visit.items : null;
  const itemRows = (items || [])
    .map(
      (item) =>
        `<tr>
           <td style="padding:7px 0; border-bottom:1.4px dashed rgba(16,15,15,0.25);">
             <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
               <tr>
                 <td style="font-family:'IBM Plex Mono',Courier,monospace; font-size:12px; color:#100F0F; padding:0;">
                   ${escapeHtml(item.quantity || 1)} × ${escapeHtml(item.name || "Artículo")}
                 </td>
                 <td align="right" style="font-family:'IBM Plex Mono',Courier,monospace; font-size:12px; color:#100F0F; padding:0; white-space:nowrap;">
                   ${money(item.total ?? item.unit_price * item.quantity)}
                 </td>
               </tr>
             </table>
           </td>
         </tr>`
    )
    .join("");

  let loyaltyHtml = "";
  if (hasReward) {
    loyaltyHtml = `
      <p style="margin:0 0 4px; font-family:'IBM Plex Mono',Courier,monospace; font-size:11.5px; font-weight:bold; color:#3DA85C; letter-spacing:0.02em; text-align:center;">VISITA REGISTRADA ✓</p>
      ${hasProgress ? `<p style="margin:0 0 4px; font-family:Arial,Helvetica,sans-serif; font-size:11px; color:#100F0F; text-align:center;">Tu tarjeta<br><strong style="font-size:13px;">${Number(cycleVisits)} / ${Number(requiredVisits)} visitas</strong></p>` : ""}
      <p style="margin:8px 0 4px; font-family:Arial,Helvetica,sans-serif; font-size:12.5px; font-weight:bold; color:#8a6a26; text-align:center; background:rgba(201,162,75,0.14); border-radius:8px; padding:6px 8px;">🎁 ¡RECOMPENSA GANADA!</p>`;
  } else if (isActive) {
    loyaltyHtml = `
      <p style="margin:0 0 4px; font-family:'IBM Plex Mono',Courier,monospace; font-size:11.5px; font-weight:bold; color:#3DA85C; letter-spacing:0.02em; text-align:center;">VISITA REGISTRADA ✓</p>
      ${hasProgress ? `<p style="margin:0 0 4px; font-family:Arial,Helvetica,sans-serif; font-size:11px; color:#100F0F; text-align:center;">Tu tarjeta<br><strong style="font-size:13px;">${Number(cycleVisits)} / ${Number(requiredVisits)} visitas</strong></p>` : ""}`;
  } else {
    loyaltyHtml = `
      <p style="margin:0 0 4px; font-family:'IBM Plex Mono',Courier,monospace; font-size:11.5px; font-weight:bold; color:#33211D; opacity:0.7; letter-spacing:0.02em; text-align:center;">COMPRA VÁLIDA: NO</p>
      <p style="margin:0 0 6px; font-family:Arial,Helvetica,sans-serif; font-size:10px; color:#33211D; opacity:0.6; text-align:center;">Visita cancelada</p>`;
  }

  const passage = resolveTicketPassageForEmail({
    verseId: visit.verse_id,
    date: visit.receipt_date ? new Date(visit.receipt_date) : visit.created_at ? new Date(visit.created_at) : new Date(),
  });
  const verseText = escapeHtml(passage.text).replace(/\n/g, "<br>");
  const verseHtml = `
    <tr>
      <td style="padding:14px 0 4px; text-align:center;">
        <div style="border-top:1.4px dashed rgba(16,15,15,0.25); margin-bottom:10px;"></div>
        <p style="margin:0 0 3px; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:10px; line-height:1.5; color:#100F0F;">“${verseText}”</p>
        <p style="margin:0; font-family:'IBM Plex Mono',Courier,monospace; font-size:9px; letter-spacing:0.04em; color:#100F0F; opacity:0.7;">${escapeHtml(passage.reference)}</p>
      </td>
    </tr>`;

  const encoded = encodeCode128(code128ValueFor(visit));
  const barcodeValue = encoded ? code128ValueFor(visit) : "";
  const barcodeHtml = encoded
    ? `
    <tr>
      <td style="padding:14px 0 2px; text-align:center;">
        ${code128BarsHtml(encoded)}
        <p style="margin:8px 0 0; font-family:'IBM Plex Mono',Courier,monospace; font-size:10px; letter-spacing:0.15em; color:#100F0F; opacity:0.7; text-align:center;">${escapeHtml(barcodeValue)}</p>
      </td>
    </tr>`
    : "";

  const appUrlTrim = String(appUrl || "").trim();
  const ctaHtml = appUrlTrim
    ? `
      <tr>
        <td align="center" style="padding:28px 32px 0;">
          <a href="${escapeHtml(appUrlTrim)}" target="_blank" rel="noopener"
             style="display:inline-block; background-color:#C9A24B; color:#FFFFFF; font-family:Arial,Helvetica,sans-serif; font-size:14px; font-weight:bold; text-decoration:none; border-radius:8px; padding:12px 26px;">
            Abrir mi tarjeta
          </a>
        </td>
      </tr>`
    : "";

  return `<!doctype html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Tu ticket de Salmos Café</title>
<!--[if mso]>
<style>
  table { border-collapse: collapse; }
</style>
<![endif]-->
<style>
  body, table, td { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  img { border: 0; line-height: 100%; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
  table { border-collapse: collapse !important; }
  body { margin: 0; padding: 0; width: 100% !important; background-color: #F5EEE2; }
  @media only screen and (max-width: 600px) {
    .sc-container { width: 100% !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:#F5EEE2;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#F5EEE2;">
    Aquí tienes el detalle de tu visita.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5EEE2;">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <table role="presentation" class="sc-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px; background-color:#FFFFFF; border-radius:16px; overflow:hidden;">

          <tr>
            <td align="center" style="background-color:#1F3355; padding:32px 24px;">
              <!-- [LOGO_URL_PROVISIONAL] misma convención que las plantillas existentes de email-templates/. -->
              <img src="https://raw.githubusercontent.com/salmoscafe/salmos-cafe-loyalty/main/email-templates/assets/wordmark-cream.png" width="180" height="58" alt="Salmos Café" style="display:block; border:0; font-family:Georgia,'Times New Roman',serif; font-size:18px; font-style:italic; color:#F5EEE2;">
            </td>
          </tr>

          <!-- Impresora + ticket (composición fiel a ReceiptPrinter de la app:
               impresora navy grande detrás, ranura/LED/"S", el ticket sale por
               debajo y se superpone parcialmente con margin negativo + z-index) -->
          <tr>
            <td align="center" style="padding:24px 16px 8px;">
              <!-- Impresora -->
                <table role="presentation" width="350" cellpadding="0" cellspacing="0" border="0" align="center" style="width:350px; position:relative; z-index:2; background-color:#1F3355; background:linear-gradient(160deg,#264063 0%,#152741 100%); border-radius:20px; box-shadow:0 16px 30px -16px rgba(23,40,69,0.55);">
                  <tr>
                    <td style="padding:16px 26px 12px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        <!-- Ranura horizontal superior + LED verde -->
                        <tr>
                          <td width="44" style="width:44px; font-size:0; line-height:0;">&nbsp;</td>
                          <td style="height:8px; background-color:#101E33; border-radius:4px; box-shadow:inset 0 2px 4px rgba(0,0,0,0.4); font-size:0; line-height:0;">&nbsp;</td>
                          <td width="44" align="right" style="width:44px; font-size:0; line-height:0;">
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right">
                              <tr>
                                <td style="width:8px; height:8px; border-radius:50%; background-color:#3DA85C; box-shadow:0 0 8px 1px rgba(60,143,92,0.8); font-size:0; line-height:0;">&nbsp;</td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                        <!-- Logo S -->
                        <tr>
                          <td colspan="3" align="center" style="padding:14px 0 8px;">
                            <span style="display:inline-block; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:15px; line-height:22px; color:#F5EEE2;">S</span>
                          </td>
                        </tr>
                        <!-- Pie oscuro (foot) -->
                        <tr>
                          <td colspan="3" style="height:6px; padding:0;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                              <tr>
                                <td style="height:6px; background-color:#152741; border-radius:0 0 6px 6px; font-size:0; line-height:0;">&nbsp;</td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <!-- Ticket (recibo térmico que sale de la impresora) -->
                <table role="presentation" width="340" cellpadding="0" cellspacing="0" border="0" align="center" style="width:340px; max-width:340px; background-color:#FBF7EF; border-radius:12px; border:1px solid rgba(16,15,15,0.10); box-shadow:0 18px 34px -18px rgba(16,15,15,0.35); position:relative; z-index:1; margin:-16px auto 0;">
                  <tr>
                    <td style="padding:18px 18px 14px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td align="center" style="padding-bottom:8px;">
                            <img src="https://raw.githubusercontent.com/salmoscafe/salmos-cafe-loyalty/main/email-templates/assets/wordmark-navy.png" width="100" height="32" alt="Salmos Café" style="display:block; border:0;">
                            <p style="margin:4px 0 0; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:9.5px; letter-spacing:0.02em; color:#33211D;">Donde el café es un verso al paladar</p>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:2px 0 10px; text-align:center;">
                            <p style="margin:0; font-family:'IBM Plex Mono',Courier,monospace; font-size:11px; color:#100F0F; line-height:1.5; word-break:break-word;">
                              Ticket #${escapeHtml(ticketRef)}<br>${escapeHtml(when)}
                            </p>
                          </td>
                        </tr>
                        <tr>
                          <td><div style="border-top:1.4px dashed rgba(16,15,15,0.25);"></div></td>
                        </tr>

                        ${itemRows}

                        <tr>
                          <td style="padding:7px 0; border-bottom:1.4px dashed rgba(16,15,15,0.25);">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                              <tr>
                                <td style="font-family:'IBM Plex Mono',Courier,monospace; font-size:14px; font-weight:bold; color:#100F0F;">TOTAL</td>
                                <td align="right" style="font-family:'IBM Plex Mono',Courier,monospace; font-size:14px; font-weight:bold; color:#100F0F; white-space:nowrap;">${total}</td>
                              </tr>
                            </table>
                          </td>
                        </tr>

                        <tr>
                          <td style="padding:12px 0 2px; text-align:center;">
                            ${loyaltyHtml}
                          </td>
                        </tr>

                        ${verseHtml}
                        ${barcodeHtml}

                        <tr>
                          <td style="padding:10px 0 0; text-align:center;">
                            <p style="margin:0; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:10.5px; color:#100F0F; opacity:0.6;">Gracias por tu visita</p>
                          </td>
                        </tr>
                        <!-- Borde dentado (ticket desprendible) -->
                        <tr>
                          <td style="padding:6px 0 0;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                              <tr>
                                ${[0, 1, 2, 3, 4, 5, 6, 7, 8].map(
                                  () =>
                                    `<td width="14" style="width:14px; height:8px; background-color:#FFFFFF; border-radius:0 0 7px 7px; font-size:0; line-height:0;">&nbsp;</td>`
                                ).join("")}
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
            </td>
          </tr>

          ${ctaHtml}

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