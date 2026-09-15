// ---------------------------------------------------------------
// ticketVerse — resolución del versículo que se imprime en el ticket.
//
// A partir de la migración 0011, cada visita guarda su propio
// `verse_id` (aleatorio al registrarse y FIJO): el ticket reproduce
// "su versículo", no el del día. Esta capa es la única que sabe cómo
// pasar del dato guardado al pasaje concreto:
//
//   * verse_id válido → el pasaje por id (getPassageById), SIEMPRE que
//     siga siendo elegible para el ticket (texto ≤ 160 chars, ≤ 3
//     líneas). Esto mantiene el diseño compacto aunque el dataset
//     cambiara y el pool de la BD envejeciera.
//   * verse_id ausente (visitas históricas pre-0011), no encontrado o
//     que ya no cabe en el ticket → fallback al pasaje del día
//     (comportamiento de 0010, getDailyShortPassage).
//
// Pura e importable desde tests (node --test).
// ---------------------------------------------------------------

import { MAX_TICKET_CHARS, MAX_TICKET_LINES, getDailyShortPassage, getPassageById } from "./psalms.js";

function isTicketEligible(passage) {
  return (
    passage.text.length <= MAX_TICKET_CHARS &&
    passage.text.split("\n").length <= MAX_TICKET_LINES
  );
}

export function resolveTicketPassage({ verseId = null, date = null } = {}) {
  if (verseId != null && verseId !== "") {
    const passage = getPassageById(verseId);
    if (passage && isTicketEligible(passage)) return passage;
  }
  return getDailyShortPassage(date ?? new Date());
}