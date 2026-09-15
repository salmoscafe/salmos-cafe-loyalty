import React from "react";
import { getDailyShortPassage } from "../../lib/psalms.js";

// TicketVerse — pasaje corto del día que se imprime DENTRO del ticket de
// fidelidad, entre la sección de visitas y el código de barras. Consume el
// dataset local vía `src/lib/psalms.js` (misma capa que DailyVerse en Home),
// sin API bíblica ni red. Es solo un detalle compacto: no tags ni metadatos.
export function TicketVerse({ date }) {
  const passage = getDailyShortPassage(date ?? new Date());

  return (
    <div className="sc-receipt__verse" aria-label="Versículo del día">
      <p className="sc-receipt__verse-text">“{passage.text}”</p>
      <p className="sc-receipt__verse-ref">{passage.reference}</p>
    </div>
  );
}