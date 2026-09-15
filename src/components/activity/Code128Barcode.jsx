import React, { useEffect, useRef } from "react";
import { code128ValueFor, drawCode128, encodeCode128 } from "../../lib/code128.js";

// ---------------------------------------------------------------
// Code128Barcode — barcode REAL (Code 128) del ticket.
//
// Renderiza el identificador real del ticket (folio de Loyverse /
// external_sale_id / id) en un <canvas>. El módulo se ajusta a lo que
// cabe en el ancho del recibo (maxWidth) para no romper el layout;
// el número legible bajo las barras lo dibuja el ticket con
// sc-receipt__barcode-num usando exactamente el mismo valor.
//
// html2canvas captura el contenido del canvas (los píxeles), así que
// el barcode se preserva en el PDF ("Descargar PDF").
// ---------------------------------------------------------------

export function Code128Barcode({ sale, barHeight = 34, quiet = 8, maxWidth = 154 } = {}) {
  const canvasRef = useRef(null);
  const value = code128ValueFor(sale);

  useEffect(() => {
    const canvas = canvasRef.current;
    const encoded = encodeCode128(value);
    if (!encoded || !canvas) {
      if (canvas) canvas.hidden = true;
      return;
    }
    canvas.hidden = false;
    drawCode128(canvas, value, { barHeight, quiet, maxWidth });
  }, [value, barHeight, quiet, maxWidth]);

  return <canvas ref={canvasRef} className="sc-receipt__barcode" aria-hidden="true" />;
}