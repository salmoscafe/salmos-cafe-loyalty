import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TOTAL_PASSAGES,
  MAX_TICKET_CHARS,
  MAX_TICKET_LINES,
  getAllPassages,
  getPassageById,
  getPassagesByTag,
  getPassagesByChapter,
  getAllTags,
  getDailyPassage,
  getDailyShortPassage,
} from "../src/lib/psalms.js";

const ALL_TAGS = [
  "dirección",
  "sabiduría",
  "confianza",
  "protección",
  "ansiedad",
  "consuelo",
  "paz",
  "amor",
  "bondad",
  "fortaleza",
  "misericordia",
  "adoración",
  "alabanza",
  "gratitud",
  "obediencia",
  "santidad",
  "transformación",
  "esperanza",
  "perseverancia",
];

test("el catálogo tiene exactamente 150 pasajes", () => {
  assert.equal(TOTAL_PASSAGES, 150);
  assert.equal(getAllPassages().length, 150);
});

test("cada pasaje tiene los campos básicos rellenados", () => {
  for (const passage of getAllPassages()) {
    assert.equal(typeof passage.id, "number");
    assert.equal(typeof passage.reference, "string");
    assert.ok(passage.reference.startsWith("Salmos"));
    assert.equal(passage.book, "Salmos");
    assert.equal(typeof passage.chapter, "number");
    assert.equal(typeof passage.startVerse, "number");
    assert.equal(typeof passage.endVerse, "number");
    assert.ok(passage.tags.length > 0);
    assert.ok(passage.text.length > 0);
  }
});

test("los ids y referencias son únicos", () => {
  const ids = getAllPassages().map((p) => p.id);
  const refs = getAllPassages().map((p) => p.reference);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(refs).size, refs.length);
});

test("getPassageById localiza un pasaje por id", () => {
  const passage = getPassageById(1);
  assert.ok(passage);
  assert.equal(passage.id, 1);
  assert.equal(passage.reference, "Salmos 1:1-3");
});

test("getPassageById devuelve undefined para ids inexistentes", () => {
  assert.equal(getPassageById(999), undefined);
  assert.equal(getPassageById(0), undefined);
});

test("getPassagesByTag filtra solo pasajes con ese tag", () => {
  const matches = getPassagesByTag("confianza");
  assert.ok(matches.length > 0);
  for (const passage of matches) {
    assert.ok(passage.tags.includes("confianza"));
  }
});

test("getPassagesByTag devuelve lista vacía para tags inexistentes", () => {
  assert.deepEqual(getPassagesByTag("tag-inexistente"), []);
});

test("getPassagesByTag es un subconjunto del catálogo completo", () => {
  const all = getAllPassages();
  const matches = getPassagesByTag("paz");
  assert.ok(matches.length < all.length);
  for (const passage of matches) {
    assert.ok(all.some((p) => p.id === passage.id));
  }
});

test("getPassagesByChapter filtra por capítulo", () => {
  const chapter1 = getPassagesByChapter(1);
  assert.ok(chapter1.length > 0);
  for (const passage of chapter1) {
    assert.equal(passage.chapter, 1);
  }
});

test("getPassagesByChapter devuelve lista vacía para capítulos fuera del dataset", () => {
  assert.deepEqual(getPassagesByChapter(999), []);
});

test("getAllTags lista las 19 etiquetas únicas", () => {
  assert.deepEqual([...getAllTags()].sort(), [...ALL_TAGS].sort());
});

test("getAllTags no repite etiquetas", () => {
  assert.equal(new Set(getAllTags()).size, getAllTags().length);
});

test("getDailyPassage es determinista para la misma fecha", () => {
  const date = new Date(2026, 8, 15); // 15 Sept 2026
  const a = getDailyPassage(date);
  const b = getDailyPassage(new Date(2026, 8, 15));
  assert.equal(a.id, b.id);
  assert.equal(a.reference, b.reference);
});

test("getDailyPassage devuelve pasajes distintos en fechas distintas", () => {
  const ids = new Set();
  for (let day = 1; day <= 20; day++) {
    ids.add(getDailyPassage(new Date(2026, 0, day)).id);
  }
  assert.ok(ids.size > 1);
});

test("getDailyPassage sin argumento retorna un pasaje válido", () => {
  const passage = getDailyPassage();
  assert.ok(passage);
  assert.ok(getAllPassages().some((p) => p.id === passage.id));
});

test("los límites de pasaje corto están exportados y son coherentes", () => {
  assert.ok(MAX_TICKET_CHARS > 0);
  assert.ok(MAX_TICKET_LINES > 0);
});

test("getDailyShortPassage retorna un pasaje del dataset", () => {
  const passage = getDailyShortPassage(new Date(2026, 8, 15));
  assert.ok(passage);
  assert.ok(getAllPassages().some((p) => p.id === passage.id));
  assert.equal(passage.book, "Salmos");
});

test("getDailyShortPassage es determinístico para la misma fecha", () => {
  const a = getDailyShortPassage(new Date(2026, 8, 15));
  const b = getDailyShortPassage(new Date(2026, 8, 15));
  assert.equal(a.id, b.id);
  assert.equal(a.reference, b.reference);
  assert.equal(a.text, b.text);
});

test("getDailyShortPassage respeta los límites de longitud y líneas", () => {
  for (let day = 1; day <= 60; day++) {
    const passage = getDailyShortPassage(new Date(2026, 0, day));
    assert.ok(
      passage.text.length <= MAX_TICKET_CHARS,
      `${passage.reference} mide ${passage.text.length} caracteres (> ${MAX_TICKET_CHARS})`
    );
    assert.ok(
      passage.text.split("\n").length <= MAX_TICKET_LINES,
      `${passage.reference} tiene ${passage.text.split("\n").length} líneas (> ${MAX_TICKET_LINES})`
    );
    assert.ok(
      getAllPassages().some((p) => p.id === passage.id),
      `${passage.reference} no está en el dataset`
    );
  }
});

test("getDailyShortPassage produce variedad a lo largo de fechas", () => {
  const ids = new Set();
  for (let day = 1; day <= 30; day++) {
    ids.add(getDailyShortPassage(new Date(2026, 3, day)).id);
  }
  assert.ok(ids.size > 1);
});

test("getDailyShortPassage sin argumento retorna un pasaje corto válido", () => {
  const passage = getDailyShortPassage();
  assert.ok(passage);
  assert.ok(passage.text.length <= MAX_TICKET_CHARS);
  assert.ok(passage.text.split("\n").length <= MAX_TICKET_LINES);
});

test("getDailyShortPassage se sostiene en un subconjunto real del catálogo", () => {
  const shorts = getAllPassages().filter(
    (p) =>
      p.text.length <= MAX_TICKET_CHARS &&
      p.text.split("\n").length <= MAX_TICKET_LINES
  );
  assert.ok(shorts.length > 0);
  assert.ok(shorts.length < getAllPassages().length);
});

test("las funciones de búsqueda no mutan el catálogo", () => {
  const before = getAllPassages().map((p) => p.id);
  getPassagesByTag("paz").push({ id: -1 });
  getPassagesByChapter(1).splice(0);
  getDailyPassage();
  const shortBefore = JSON.stringify(getAllPassages());
  getDailyShortPassage();
  assert.deepEqual(
    getAllPassages().map((p) => p.id),
    before
  );
  assert.equal(JSON.stringify(getAllPassages()), shortBefore);
});