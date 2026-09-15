import passages from "../data/bible-verses.json" with { type: "json" };

export const TOTAL_PASSAGES = passages.length;

// Límites para el pasaje corto del ticket de fidelidad: el texto no debe
// superar estas dimensiones para mantener el ticket compacto. Nunca se
// trunca un pasaje; solo se descartan los que no caben.
export const MAX_TICKET_CHARS = 160;
export const MAX_TICKET_LINES = 3;

function dateSeed(date) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

export function getAllPassages() {
  return passages;
}

export function getPassageById(id) {
  return passages.find((passage) => passage.id === id);
}

export function getPassagesByTag(tag) {
  return passages.filter((passage) => passage.tags.includes(tag));
}

export function getPassagesByChapter(chapter) {
  return passages.filter((passage) => passage.chapter === chapter);
}

export function getAllTags() {
  return [...new Set(passages.flatMap((passage) => passage.tags))];
}

export function getDailyPassage(date = new Date()) {
  return passages[dateSeed(date) % passages.length];
}

// Selección determinística restringida a pasajes cortos (para el ticket).
// Filtra el dataset local sin modificarlo y elige por fecha; si no hubiera
// candidatos (no ocurre con el dataset actual) cae al catálogo completo.
export function getDailyShortPassage(date = new Date()) {
  const short = passages.filter(
    (passage) =>
      passage.text.length <= MAX_TICKET_CHARS &&
      passage.text.split("\n").length <= MAX_TICKET_LINES
  );
  const pool = short.length > 0 ? short : passages;
  return pool[dateSeed(date) % pool.length];
}