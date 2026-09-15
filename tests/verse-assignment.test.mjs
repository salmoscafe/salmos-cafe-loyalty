// Suite de la asignación de versículo por visita (migración 0011).
//
// Hasta 0010, el ticket mostraba el pasaje "del día" (por fecha), así
// que todos los tickets del mismo día repetían el mismo versículo.
// Desde 0011, cada visita recibe su propio verse_id ALETORIO al
// registrarse y lo conserva siempre (idempotencia por external_sale_id).
//
// Qué se testea aquí (espejo puro de la regla SQL de 0011):
//   * una visita nueva recibe un verse_id del pool de tickets;
//   * dos tickets (mismo día o no) pueden recibir verse_id distintos;
//   * reprocesar el mismo recibo NO cambia el verse_id ya asignado;
//   * el frontend resuelve el pasaje EXACTO por verse_id;
//   * un verse_id inválido/ausente cae al fallback por fecha;
//   * TICKET_VERSE_IDS se mantiene en sincronía con el dataset
//     (ids existentes y elegibles para el ticket).

import test from "node:test";
import assert from "node:assert/strict";

import {
  TICKET_VERSE_IDS,
  pickRandomVerseId,
  resolveVisitVerseId,
} from "../supabase/functions/_shared/receiptsSyncCore.js";
import { getDailyShortPassage, getPassageById } from "../src/lib/psalms.js";
import { resolveTicketPassage } from "../src/lib/ticketVerse.js";

// ---------------------------------------------------------------
// Coherencia pool ↔ dataset (0011: bible_verse_pool en la BD debe
// reflejar estos mismos ids).
// ---------------------------------------------------------------
test("TICKET_VERSE_IDS: cada id existe en el dataset", () => {
  for (const id of TICKET_VERSE_IDS) {
    assert.ok(getPassageById(id), `verse_id ${id} no existe en bible-verses.json`);
  }
});

test("TICKET_VERSE_IDS: cada id es elegible para el ticket (límites de psalms.js)", () => {
  for (const id of TICKET_VERSE_IDS) {
    const passage = getPassageById(id);
    assert.ok(passage.text.length <= 160, `pasaje ${id} excede 160 chars`);
    assert.ok(passage.text.split("\n").length <= 3, `pasaje ${id} excede 3 líneas`);
  }
});

test("TICKET_VERSE_IDS: ids únicos y pool no vacío", () => {
  assert.equal(new Set(TICKET_VERSE_IDS).size, TICKET_VERSE_IDS.length);
  assert.ok(TICKET_VERSE_IDS.length > 1);
});

// ---------------------------------------------------------------
// 1) Una visita nueva recibe verse_id.
// ---------------------------------------------------------------
test("una visita nueva (sin verse_id) recibe un verse_id del pool", () => {
  const verseId = resolveVisitVerseId({ existingVerseId: null });
  assert.ok(TICKET_VERSE_IDS.includes(verseId), `got ${verseId}`);
});

test("pickRandomVerseId siempre devuelve un id del pool", () => {
  for (let i = 0; i < 50; i++) {
    const id = pickRandomVerseId();
    assert.ok(TICKET_VERSE_IDS.includes(id));
  }
});

// ---------------------------------------------------------------
// 2) Dos tickets pueden recibir verse_id distintos.
// ---------------------------------------------------------------
test("dos tickets (mismo día) pueden recibir verse_id distintos", () => {
  // Vista nueva dos veces: valores independientes pueden (y suelen) diferir.
  const a = resolveVisitVerseId({ existingVerseId: null });
  const b = resolveVisitVerseId({ existingVerseId: null });
  assert.ok(TICKET_VERSE_IDS.includes(a));
  assert.ok(TICKET_VERSE_IDS.includes(b));
  // No hay colisión forzada: con un pool de >1 id, la asignación
  // independiente admite valores distintos (probado por variedad).
  const seen = new Set(Array.from({ length: 40 }, () => pickRandomVerseId()));
  assert.ok(seen.size > 1, "el pool produce variedad");
});

// ---------------------------------------------------------------
// 3) Reprocesar el mismo recibo NO cambia el verse_id.
// ---------------------------------------------------------------
test("reprocesar el mismo recibo conserva el verse_id (no se regenera)", () => {
  const first = resolveVisitVerseId({ existingVerseId: 42, proposedVerseId: 77 });
  const second = resolveVisitVerseId({ existingVerseId: 42, proposedVerseId: 99 });
  assert.equal(first, 42);
  assert.equal(second, 42);
});

test("un verse_id ya asignado siempre gana sobre cualquier propuesta", () => {
  for (const existing of TICKET_VERSE_IDS) {
    const got = resolveVisitVerseId({ existingVerseId: existing, proposedVerseId: pickRandomVerseId() });
    assert.equal(got, existing);
  }
});

// ---------------------------------------------------------------
// 4) TicketVerse muestra el versículo correspondiente al verse_id.
// ---------------------------------------------------------------
test("resolveTicketPassage devuelve el pasaje EXACTO del verse_id", () => {
  const id = TICKET_VERSE_IDS[0];
  const passage = resolveTicketPassage({ verseId: id, date: new Date(2026, 0, 1) });
  assert.equal(passage.id, id);
  assert.equal(passage.reference, getPassageById(id).reference);
  // La fecha NO influye cuando hay verse_id (el versículo es fijo).
  const sameDay = resolveTicketPassage({ verseId: id, date: new Date(2026, 5, 15) });
  assert.equal(sameDay.id, id);
});

test("cualquier id del pool resuelve a su propio pasaje (reproducible)", () => {
  for (const id of TICKET_VERSE_IDS) {
    const passage = resolveTicketPassage({ verseId: id });
    assert.equal(passage.id, id, `${TICKET_VERSE_IDS.indexOf(id)}`);
  }
});

// ---------------------------------------------------------------
// 5) verse_id inválido / ausente → fallback por fecha.
// ---------------------------------------------------------------
test("verse_id ausente (histórico pre-0011) usa el fallback por fecha", () => {
  const date = new Date(2026, 8, 15);
  const fallback = getDailyShortPassage(date);
  assert.equal(resolveTicketPassage({ verseId: null, date }), fallback);
  assert.equal(resolveTicketPassage({ verseId: undefined, date }), fallback);
});

test("verse_id no encontrado en el dataset usa el fallback por fecha", () => {
  const date = new Date(2026, 8, 15);
  const fallback = getDailyShortPassage(date);
  assert.equal(resolveTicketPassage({ verseId: 99999, date }), fallback);
  assert.equal(resolveTicketPassage({ verseId: "no-existe", date }), fallback);
});

test("sin verse_id y sin fecha usa el versículo de HOY (comportamiento 0010)", () => {
  const today = getDailyShortPassage();
  assert.equal(resolveTicketPassage({ verseId: null }), today);
});