import React from "react";
import { resolveTicketPassage } from "../../lib/ticketVerse.js";

// TicketVerse — pasaje FIJO que se imprime dentro del ticket de
// fidelidad (cada visita recibe un verse_id aleatorio al registrarse,
// migración 0011). Se muestra directamente ese versículo; el cálculo
// por fecha queda SOLO como fallback para visitas históricas previas
// a 0011 (verse_id = null) o ids que ya no existan en el dataset.
// Consume el dataset local vía `src/lib/psalms.js` (misma capa que
// DailyVerse en Home), sin API bíblica ni red.
export function TicketVerse({ verseId, date }) {
  const passage = resolveTicketPassage({ verseId, date });

  return (
    <div className="sc-receipt__verse" aria-label="Versículo de tu visita">
      <p className="sc-receipt__verse-text">“{passage.text}”</p>
      <p className="sc-receipt__verse-ref">{passage.reference}</p>
    </div>
  );
}