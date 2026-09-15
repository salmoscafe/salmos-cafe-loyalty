import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../common/icons.jsx";
import { formatReceiptWhen } from "../../lib/format.js";
import { WORDMARK_NAVY, ICON_CREAM } from "../../lib/brandAssets.js";
import { downloadReceiptPdf } from "../../lib/receiptPdf.js";
import { sendTicketEmail } from "../../services/email/ticketEmailService.js";
import { Code128Barcode } from "./Code128Barcode.jsx";
import { TicketVerse } from "./TicketVerse.jsx";

// -----------------------------------------------------------------
// ReceiptPrinter — detalle POS de una compra (vista Cliente).
//
// Fuente de referencia visual/interacción:
// `salmos-activity-demo.html` (impresora, ranura, LED, papel térmico,
// animación de impresión, clip-path, max-height, jitter, spinner,
// check, borde dentado, barcode y desglose del ticket).
//
// Máquina de estados (igual al prototipo):
//   idle → preparing (950ms) → printing (1450ms) → complete
//
//   preparing  ticket oculto (receipt-wrap colapsado + clip-path 100%),
//              sin hueco vacío; spinner visible; LED no verde;
//              "Preparando tu ticket…".
//   printing   "Imprimiendo tu ticket…": receipt-wrap crece a la altura
//              real mientras el papel se revela con clip-path (las dos
//              transiciones corren sincronizadas) + jitter sutil.
//   complete   "Ticket listo": sin jitter, spinner oculto, check verde,
//              LED verde, ticket completo, acciones finales.
//
// Con prefers-reduced-motion se salta la animación y se muestra el
// ticket completo en estado complete.
//
// El ticket usa SOLO datos reales de `loyalty_visits` (vía
// salesService.toClientSale): externalSaleId, items (line_items del
// receipt, migración 0010), receiptDate, amount, status,
// triggeredRewardId, folio y progreso del ciclo. No se inventan
// productos, métodos de pago, cajeros ni impuestos.
// -----------------------------------------------------------------

const TIMING = { preparing: 950, printing: 1450 };

// Formato del ticket demo: enteros sin .00 ("$120"), decimales con 2
// cifras ("$59.99"). Nunca moneda localizada: es un recibo de POS.
function money(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "$0";
  return "$" + v.toFixed(2).replace(/\.00$/, "");
}

// Valor REAL que codifica el barcode del ticket: el folio de Loyverse
// (receipt_number) cuando existe, luego external_sale_id, luego id.
// Nada inventado — el número legible bajo las barras es este mismo.
function barcodeValueFor(sale) {
  const folio = typeof sale?.folio === "string" && sale.folio !== "" ? sale.folio : "";
  const external = typeof sale?.externalSaleId === "string" && sale.externalSaleId !== "" ? sale.externalSaleId : "";
  const fallback = typeof sale?.id === "string" ? sale.id : "";
  return folio || external || fallback;
}

function mailMessageFor(code) {
  switch (code) {
    case "email_not_configured":
      return "El envío por correo no está disponible todavía.";
    case "unauthorized":
    case "no_email":
    case "customer_setup_required":
      return "No pudimos identificar tu correo para el envío.";
    case "ticket_not_found":
      return "No encontramos este ticket para enviarlo.";
    default:
      return "No pudimos enviar el correo. Intenta de nuevo.";
  }
}

export function ReceiptPrinter({ sale, onClose }) {
  const [phase, setPhase] = useState("preparing");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [wrapHeight, setWrapHeight] = useState("0px");
  const [clipInset, setClipInset] = useState("inset(0 0 100% 0)");
  const [pdfState, setPdfState] = useState("idle");
  const [mail, setMail] = useState({ status: "idle", error: null });

  const receiptRef = useRef(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e) => setReducedMotion(e.matches);
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      setPhase("complete");
      setClipInset("inset(0 0 0 0)");
      setWrapHeight("none");
      return;
    }
    const t1 = setTimeout(() => {
      const el = receiptRef.current;
      setPhase("printing");
      setWrapHeight(el ? `${el.scrollHeight}px` : "auto");
      setClipInset("inset(0 0 0 0)");
    }, TIMING.preparing);
    const t2 = setTimeout(() => setPhase("complete"), TIMING.preparing + TIMING.printing);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [reducedMotion]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleDownloadPdf() {
    if (pdfState === "busy") return;
    setPdfState("busy");
    const result = await downloadReceiptPdf({
      receiptEl: receiptRef.current,
      externalSaleId: sale.externalSaleId,
    });
    setPdfState(result.ok ? "done" : "error");
  }

  async function handleSendMail() {
    if (mail.status === "sending") return;
    setMail({ status: "sending", error: null });
    const result = await sendTicketEmail({ externalSaleId: sale.externalSaleId });
    setMail(result.ok ? { status: "sent", error: null } : { status: "error", error: mailMessageFor(result.code) });
  }

  const isActive = sale.status === "active" || sale.status === "completed";
  const hasReward = isActive && !!sale.triggeredRewardId;
  const hasProgress = Number.isFinite(Number(sale.cycleVisits));
  const items = Array.isArray(sale.items) && sale.items.length > 0 ? sale.items : null;
  const ticketRef = sale.folio || sale.externalSaleId || sale.id;
  const when = formatReceiptWhen(sale.receiptDate || sale.createdAt);
  const barcodeValue = barcodeValueFor(sale);

  return (
    <div className="sc-printer-stage">
      <div className="sc-printer" aria-hidden="true">
        <div className="sc-printer__slot" />
        <span className="sc-printer__mark">
          <img className="sc-printer__mark-img" src={ICON_CREAM} alt="" />
        </span>
        <span className={`sc-printer__led${phase === "complete" ? " sc-printer__led--green" : ""}`} />
        <div className="sc-printer__foot" />
      </div>

      <div className="sc-receipt-wrap" style={{ maxHeight: wrapHeight }}>
        <div
          ref={receiptRef}
          className={`sc-receipt${phase === "printing" ? " sc-receipt--jittering" : ""}`}
          style={{ clipPath: clipInset }}
        >
          <div className="sc-receipt__inner">
            <div className="sc-receipt__header">
              <img className="sc-receipt__wordmark" src={WORDMARK_NAVY} alt="Salmos Café" />
              <p className="sc-receipt__tagline">Donde el café es un verso al paladar</p>
            </div>

            <p className="sc-receipt__meta">
              Ticket #{ticketRef}
              <br />
              {when}
            </p>

            <div className="sc-receipt__divider" />

            {items &&
              items.map((item, idx) => (
                <div className="sc-receipt__row" key={`${item.name}-${idx}`}>
                  <span>
                    <strong>{item.quantity}</strong> × {item.name}
                  </span>
                  <span>{money(item.total ?? item.unit_price * item.quantity)}</span>
                </div>
              ))}

            <div className="sc-receipt__row sc-receipt__row--total">
              <span>TOTAL</span>
              <span>{money(sale.amount)}</span>
            </div>

            <div className="sc-receipt__divider" />

            <div className="sc-receipt__loyalty">
              {hasReward && (
                <>
                  <p className="sc-receipt__visit-ok">VISITA REGISTRADA ✓</p>
                  {hasProgress && (
                    <p className="sc-receipt__cardline">
                      Tu tarjeta<br />
                      <strong>
                        {sale.cycleVisits} / {sale.requiredVisits} visitas
                      </strong>
                    </p>
                  )}
                  <p className="sc-receipt__reward">🎁 ¡RECOMPENSA GANADA!</p>
                </>
              )}
              {!hasReward && isActive && (
                <>
                  <p className="sc-receipt__visit-ok">VISITA REGISTRADA ✓</p>
                  {hasProgress && (
                    <p className="sc-receipt__cardline">
                      Tu tarjeta<br />
                      <strong>
                        {sale.cycleVisits} / {sale.requiredVisits} visitas
                      </strong>
                    </p>
                  )}
                </>
              )}
              {!isActive && (
                <>
                  <p className="sc-receipt__visit-no">COMPRA VÁLIDA: NO</p>
                  <p className="sc-receipt__explain">Visita cancelada</p>
                </>
              )}
            </div>

            <TicketVerse
              verseId={sale?.verseId}
              date={new Date(sale?.receiptDate || sale?.createdAt || new Date())}
            />

            <Code128Barcode sale={sale} />
            {barcodeValue && <p className="sc-receipt__barcode-num">{barcodeValue}</p>}

            <p className="sc-receipt__thanks">Gracias por tu visita</p>
          </div>
          <div className="sc-receipt__tear" />
        </div>
      </div>

      <div className="sc-status-row" role="status" aria-live="polite">
        {phase !== "complete" && <span className="sc-printer-spinner" aria-hidden="true" />}
        {phase === "complete" && (
          <span className="sc-complete-check" aria-hidden="true">
            ✓
          </span>
        )}
        <span className="sc-status-text">
          {phase === "preparing" && "Preparando tu ticket…"}
          {phase === "printing" && "Imprimiendo tu ticket…"}
          {phase === "complete" && "Ticket listo"}
        </span>
      </div>

      {phase === "complete" && (
        <div className="sc-receipt-actions">
          <button
            type="button"
            className="sc-btn-primary sc-receipt-actions__btn"
            onClick={handleDownloadPdf}
            disabled={pdfState === "busy"}
          >
            <span className="sc-receipt-actions__btn-icon">
              <Icon.Download />
            </span>
            {pdfState === "busy" ? "Generando PDF…" : "Descargar PDF"}
          </button>

          <button
            type="button"
            className="sc-btn-secondary sc-receipt-actions__btn"
            onClick={handleSendMail}
            disabled={mail.status === "sending"}
          >
            <span className="sc-btn-secondary__icon">
              <Icon.Mail />
            </span>
            {mail.status === "sending" ? "Enviando…" : "Enviar por correo"}
          </button>

          {pdfState === "error" && (
            <p className="sc-receipt-actions__msg sc-receipt-actions__msg--err">No pudimos generar el PDF.</p>
          )}
          {mail.status === "sent" && (
            <p className="sc-receipt-actions__msg sc-receipt-actions__msg--ok">Ticket enviado a tu correo.</p>
          )}
          {mail.status === "error" && (
            <p className="sc-receipt-actions__msg sc-receipt-actions__msg--err">{mail.error}</p>
          )}
        </div>
      )}
    </div>
  );
}