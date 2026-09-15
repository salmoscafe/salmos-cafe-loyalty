// ---------------------------------------------------------------
// receiptPdf — "Descargar PDF" del ticket de Activity.
//
// Genera un PDF que contiene SOLO el receipt (el elemento `receipt`),
// nunca la pantalla: ni título, ni impresora, ni botones.
//
// Pipeline: html2canvas (captura del nodo receipt) → jsPDF (una
// página con la imagen del ticket). Los imports son dinámicos para no
// inflar el bundle inicial: solo se cargan al pulsar "Descargar PDF".
// ---------------------------------------------------------------

export async function downloadReceiptPdf({ receiptEl, externalSaleId }) {
  if (!receiptEl) return { ok: false, code: "receipt_not_ready" };

  let html2canvas;
  let jsPDFClass;
  try {
    [{ default: html2canvas }, { jsPDF: jsPDFClass }] = await Promise.all([
      import("html2canvas"),
      import("jspdf"),
    ]);
  } catch {
    return { ok: false, code: "pdf_library_unavailable" };
  }

  let canvas;
  try {
    canvas = await html2canvas(receiptEl, {
      backgroundColor: "#FBF7EF",
      scale: 2,
      logging: false,
    });
  } catch {
    return { ok: false, code: "pdf_capture_failed" };
  }

  // El PDF se cierra a la medida exacta del ticket (1:1 a escala real).
  const imgData = canvas.toDataURL("image/png");
  const pdf = new jsPDFClass({
    orientation: "p",
    unit: "px",
    format: [canvas.width / 2, canvas.height / 2],
  });
  pdf.addImage(imgData, "PNG", 0, 0, canvas.width / 2, canvas.height / 2);

  const safeRef = String(externalSaleId || "ticket").replace(/[^a-zA-Z0-9_-]/g, "") || "ticket";
  pdf.save(`ticket-salmos-${safeRef}.pdf`);

  return { ok: true };
}