// Suite de paridad del correo del ticket (send-ticket).
//
// El correo se genera SERVER-SIDE (Edge Function) con mirrors en
// supabase/functions/_shared/ porque src/ no se empaqueta al desplegar
// Supabase. Este archivo verifica que esos mirrors son IDÉNTICOS a lo
// que corre en el cliente:
//   * versículo: pool de 49 pasajes elegibles, texto/referencia y
//     fallback por fecha contra src/lib/psalms.js + src/lib/ticketVerse.js
//     + pool TICKET_VERSE_IDS de receiptsSyncCore.
//   * barcode: valor (folio > external_sale_id > id) y módulos Code 128
//     contra src/lib/code128.js.
//   * progreso del ciclo contra salesService.computeCycleProgress.
//   * dinero y fecha/hora del ticket contra el formato de la app.
//   * el HTML renderizado NUNCA contiene datos de ejemplo (Claude),
//     placeholders ("[TICKET_NUMBER]", "SC[") ni inventa URLs.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TICKET_CHARS,
  MAX_TICKET_LINES,
  getAllPassages,
  getDailyShortPassage,
} from "../src/lib/psalms.js";
import { resolveTicketPassage } from "../src/lib/ticketVerse.js";
import { code128ValueFor as appCode128ValueFor, encodeCode128 as appEncodeCode128 } from "../src/lib/code128.js";
import { computeCycleProgress as appComputeCycleProgress } from "../src/services/sales/salesService.js";
import { TICKET_VERSE_IDS } from "../supabase/functions/_shared/receiptsSyncCore.js";

import {
  getPassageByIdForEmail,
  getDailyShortPassageForEmail,
  resolveTicketPassageForEmail,
} from "../supabase/functions/_shared/ticketEmailVerses.js";
import {
  folioFor,
  code128ValueFor,
  encodeCode128,
} from "../supabase/functions/_shared/ticketEmailCode128.js";
import {
  money,
  formatReceiptWhenForEmail,
  computeCycleVisitProgress,
  renderTicketEmail,
} from "../supabase/functions/_shared/ticketEmail.js";

function isEligible(passage) {
  return (
    passage.text.length <= MAX_TICKET_CHARS &&
    passage.text.split("\n").length <= MAX_TICKET_LINES
  );
}

function keyOf(passage) {
  return { id: passage.id, reference: passage.reference, text: passage.text };
}

// ---------------------------------------------------------------
// 1. Versículo: el pool embebido en el mirror es EXACTAMENTE el
//    conjunto elegible del dataset (y == TICKET_VERSE_IDS), con el
//    mismo texto/referencia byte a byte.
// ---------------------------------------------------------------
test("versículo: el pool del mirror son los 49 pasajes elegibles con texto/referencia exactos", () => {
  const eligible = getAllPassages().filter(isEligible);
  assert.equal(eligible.length, 49, "debe haber exactamente 49 pasajes elegibles");

  const eligibleIds = new Set(eligible.map((p) => p.id));
  for (const passage of getAllPassages()) {
    const mirror = getPassageByIdForEmail(passage.id);
    if (eligibleIds.has(passage.id)) {
      assert.deepEqual(keyOf(mirror), keyOf(passage), `pasaje ${passage.id} debe coincidir`);
    } else {
      assert.equal(mirror, null, `pasaje ${passage.id} no es elegible y no debe existir en el mirror`);
    }
  }

  assert.deepEqual(
    [...TICKET_VERSE_IDS].sort(),
    [...eligibleIds].sort(),
    "el pool de la BD (TICKET_VERSE_IDS) debe ser exactamente el conjunto elegible"
  );
});

test("versículo: fallback por fecha idéntico al de la app (getDailyShortPassage)", () => {
  const dates = [];
  for (let d = 0; d < 366; d += 17) {
    dates.push(new Date(Date.UTC(2026, 0, 1 + d, 15, 0, 0)));
  }
  for (const date of dates) {
    assert.deepEqual(
      keyOf(getDailyShortPassageForEmail(date)),
      keyOf(getDailyShortPassage(date)),
      `fallback para ${date.toISOString()} debe coincidir`
    );
  }
});

test("versículo: resolveTicketPassage del mirror coincide con la app (id, no-elegible, desconocido, nulo)", () => {
  const longPassage = getAllPassages().find((p) => !isEligible(p));
  assert.ok(longPassage, "el dataset debe tener algún pasaje no elegible");
  const shortPassage = getAllPassages().find(isEligible);
  const date = new Date("2026-09-14T15:00:00.000Z");

  const cases = [
    { verseId: shortPassage.id, date },
    { verseId: longPassage.id, date },
    { verseId: "no-existe", date },
    { verseId: null, date },
    { verseId: "", date },
    { verseId: "00000000", date },
  ];
  for (const c of cases) {
    assert.deepEqual(
      keyOf(resolveTicketPassageForEmail(c)),
      keyOf(resolveTicketPassage(c)),
      `verseId=${JSON.stringify(c.verseId)}`
    );
  }
});

// ---------------------------------------------------------------
// 2. Barcode: valor (folio > external_sale_id > id) y módulos Code 128
//    idénticos a la app para folios reales.
// ---------------------------------------------------------------
test("barcode: folios reales — valor y módulos idénticos a la app", () => {
  const folios = ["1-0759", "1-0784", "1-0980", "1-0997"];
  for (const folio of folios) {
    const visit = { id: "visit-uuid-123", external_sale_id: `loyverse_receipt_s1_${folio}` };
    const sale = { id: visit.id, externalSaleId: visit.external_sale_id, folio: folioFor(visit) };

    const mirrorValue = code128ValueFor(visit);
    assert.equal(mirrorValue, appCode128ValueFor(sale), `valor para ${folio}`);

    const mirrorEnc = encodeCode128(mirrorValue);
    const appEnc = appEncodeCode128(appCode128ValueFor(sale));
    assert.deepEqual(mirrorEnc, appEnc, `codificación para ${folio}`);
  }
});

test("barcode: folioFor replica buildFolio (último segmento, luego id→8)", () => {
  assert.equal(folioFor({ external_sale_id: "loyverse_receipt_2_1-0997", id: "x" }), "1-0997");
  assert.equal(folioFor({ external_sale_id: "solo_un_segmento", id: "x" }), "segmento");
  assert.equal(folioFor({ external_sale_id: "", id: "sale_1234567890" }), "sale_123");
  assert.equal(folioFor({ external_sale_id: null, id: "abc" }), "abc");
  assert.equal(code128ValueFor({}), "");
  assert.equal(encodeCode128(""), null);
  assert.equal(encodeCode128("ñ"), null);
});

// ---------------------------------------------------------------
// 3. Progreso del ciclo: idéntico a salesService.computeCycleProgress.
// ---------------------------------------------------------------
test("progreso: computeCycleVisitProgress replica computeCycleProgress", () => {
  const visits = [
    { id: "a", cycle_id: "cy1", status: "active", receipt_date: "2026-09-01T10:00:00Z", created_at: "2026-09-02T00:00:00Z" },
    { id: "b", cycle_id: "cy1", status: "active", receipt_date: "2026-09-05T10:00:00Z", created_at: "2026-09-06T00:00:00Z" },
    { id: "c", cycle_id: "cy1", status: "cancelled", receipt_date: "2026-09-08T10:00:00Z", created_at: "2026-09-09T00:00:00Z" },
    { id: "d", cycle_id: "cy2", status: "active", visit_date: "2026-09-03T10:00:00Z", created_at: "2026-09-01T00:00:00Z" },
    { id: "e", cycle_id: "cy2", status: "active", created_at: "2026-08-30T00:00:00Z" },
    { id: "f", cycle_id: "cy1", status: "active", receipt_date: "2026-09-10T10:00:00Z", created_at: "2026-09-11T00:00:00Z" },
  ];

  const app = new Map(appComputeCycleProgress(visits));
  const mirror = computeCycleVisitProgress(visits);
  for (const [id, progress] of app) {
    assert.equal(mirror.get(id), progress, `progreso del visit ${id}`);
  }
  assert.deepEqual([...mirror.keys()].sort(), [...app.keys()].sort());
});

// ---------------------------------------------------------------
// 4. Dinero y fecha/hora del recibo (formato del ticket).
// ---------------------------------------------------------------
test("money replica el formato del ticket (sin .00 en enteros)", () => {
  assert.equal(money(120), "$120");
  assert.equal(money(59.99), "$59.99");
  assert.equal(money(0), "$0");
  assert.equal(money(120.5), "$120.50");
  assert.equal(money("120"), "$120");
  assert.equal(money(NaN), "$0");
  assert.equal(money(undefined), "$0");
});

test("formatReceiptWhenForEmail: mismo patrón del ticket en America/Tijuana", () => {
  assert.equal(formatReceiptWhenForEmail("2026-09-14T15:00:00.000Z"), "14 Sept 2026 · 08:00");
  assert.equal(formatReceiptWhenForEmail("2026-01-15T17:00:00.000Z"), "15 Jan 2026 · 09:00");
  assert.match(formatReceiptWhenForEmail("2026-07-04T14:05:00.000Z"), /^4 Jul 2026 · 07:05$/);
  assert.equal(formatReceiptWhenForEmail("no-es-fecha"), "no-es-fecha");
  // new Date(null) == epoch → misma salida que la app (formatea 1969).
  assert.equal(formatReceiptWhenForEmail(null), "31 Dec 1969 · 16:00");
});

// ---------------------------------------------------------------
// 5. HTML renderizado: estados del ticket, datos reales, sin ejemplos
//    de Claude ni placeholders.
// ---------------------------------------------------------------
const VISITS_FOR_PROGRESS = [
  { id: "v1", cycle_id: "cy", status: "active", receipt_date: "2026-09-01T10:00:00Z" },
  { id: "v2", cycle_id: "cy", status: "active", receipt_date: "2026-09-14T10:00:00Z" },
];

function baseVisit(overrides = {}) {
  return {
    id: "visit-uuid-123",
    external_sale_id: "loyverse_receipt_s1_1-0997",
    store_id: "s1",
    status: "active",
    amount: 120,
    triggered_reward_id: "reward-1",
    receipt_date: "2026-09-14T15:00:00.000Z",
    created_at: "2026-09-14T15:05:12.000Z",
    verse_id: TICKET_VERSE_IDS[0],
    items: [
      { name: "Café de olla", quantity: 2, unit_price: 55, total: 110 },
      { name: "Filosofía de la esquina", quantity: 1, unit_price: 10, total: 10 },
    ],
    ...overrides,
  };
}

const NO_FAKE = /Latte|Croissant|Cold brew|SC\[|\[TICKET_NUMBER\]/;
const FORBIDDEN_ITEMS = ["Latte", "Croissant", "Cold brew"];

function assertNoFakeData(html) {
  assert.doesNotMatch(html, NO_FAKE, "el HTML no debe contener datos de ejemplo ni placeholders");
}

test("render: visita activa con recompensa muestra el ticket completo", () => {
  const visit = baseVisit({ id: "v2" });
  const progress = computeCycleVisitProgress(VISITS_FOR_PROGRESS);
  const html = renderTicketEmail({
    visit,
    cycleVisits: progress.get(visit.id),
    requiredVisits: 7,
    appUrl: "https://app.salmoscafe.mx",
  });

  assert.match(html, /wordmark-cream\.png/);
  assert.match(html, /wordmark-navy\.png/);
  assert.match(html, /Ticket #1-0997/);
  assert.match(html, /14 Sept 2026 · 08:00/);
  assert.match(html, /2 × Café de olla/);
  assert.match(html, /Filosofía de la esquina/);
  assert.match(html, /\$120/); // total
  assert.match(html, /VISITA REGISTRADA ✓/);
  assert.match(html, /Tu tarjeta/);
  assert.match(html, /2 \/ 7 visitas/);
  assert.match(html, /🎁 ¡RECOMPENSA GANADA!/);
  // imágenes con URL absoluta (requisito de los correos)
  assert.match(html, /src="https:\/\/raw\.githubusercontent\.com\/salmoscafe\/salmos-cafe-loyalty\/main\/email-templates\/assets\/wordmark-cream\.png"/);
  assert.match(html, /src="https:\/\/raw\.githubusercontent\.com\/salmoscafe\/salmos-cafe-loyalty\/main\/email-templates\/assets\/wordmark-navy\.png"/);
  assert.match(html, /Abrir mi tarjeta/);
  assert.match(html, /href="https:\/\/app\.salmoscafe\.mx"/);
  assert.match(html, /Gracias por tu visita/);
  assertNoFakeData(html);
});

test("render: importa el versículo real del visit y el barcode real", () => {
  const visit = baseVisit({ id: "v2" });
  const progress = computeCycleVisitProgress(VISITS_FOR_PROGRESS);
  const html = renderTicketEmail({ visit, cycleVisits: progress.get(visit.id), requiredVisits: 7 });

  const passage = requirePassage(visit.verse_id);
  assert.ok(
    html.includes(`“${passage.text.replace(/\n/g, "<br>")}”`),
    "debe mostrar el versículo guardado con comillas del ticket"
  );
  assert.ok(html.includes(passage.reference), "debe mostrar la referencia");

  const barcodeValue = code128ValueFor(visit);
  assert.equal(barcodeValue, "1-0997");
  assert.ok(html.includes(`>${barcodeValue}</p>`), "el número bajo las barras es el valor codificado");
  assert.ok(html.includes("background-color:#101010;"), "las barras del barcode se renderizan");
});

function requirePassage(id) {
  const found = getPassageByIdForEmail(id);
  assert.ok(found, `pasaje ${id} debe existir en el mirror`);
  return found;
}

test("render: visita activa sin recompensa no muestra recompensa", () => {
  const html = renderTicketEmail({ visit: baseVisit({ triggered_reward_id: null }), cycleVisits: 1, requiredVisits: 7 });
  assert.match(html, /VISITA REGISTRADA ✓/);
  assert.doesNotMatch(html, /RECOMPENSA GANADA/);
  assertNoFakeData(html);
});

test("render: visita cancelada muestra el bloque cancelado (no recompensa)", () => {
  const html = renderTicketEmail({
    visit: baseVisit({ status: "cancelled", triggered_reward_id: "reward-1" }),
    cycleVisits: null,
    requiredVisits: null,
  });
  assert.match(html, /COMPRA VÁLIDA: NO/);
  assert.match(html, /Visita cancelada/);
  assert.doesNotMatch(html, /VISITA REGISTRADA/);
  assert.doesNotMatch(html, /RECOMPENSA GANADA/);
  assert.doesNotMatch(html, /Tu tarjeta/);
  assertNoFakeData(html);
});

test("render: sin progreso disponible se omite la línea del contador", () => {
  const html = renderTicketEmail({ visit: baseVisit(), cycleVisits: null, requiredVisits: null });
  assert.match(html, /VISITA REGISTRADA ✓/);
  assert.match(html, /RECOMPENSA GANADA/);
  assert.doesNotMatch(html, /Tu tarjeta/);
  assert.doesNotMatch(html, /\/ 7 visitas/);
  assertNoFakeData(html);
});

test("render: el barcode usa el folio del visit (número bajo las barras = valor codificado)", () => {
  const html = renderTicketEmail({ visit: baseVisit(), cycleVisits: null, requiredVisits: null });
  assert.match(html, />1-0997<\/p>/);
  assert.ok(html.includes("background-color:#101010;"));
  assertNoFakeData(html);
});

test("render: sin SMTP_APP_URL no hay CTA (no se inventa URL)", () => {
  const html = renderTicketEmail({ visit: baseVisit(), cycleVisits: 2, requiredVisits: 7, appUrl: "" });
  assert.doesNotMatch(html, /Abrir mi tarjeta/);
  assert.doesNotMatch(html, /<a href=/);
  assertNoFakeData(html);
});

test("render: escapa contenido del cliente (nombres, versículo)", () => {
  const visit = baseVisit({
    items: [
      { name: `Latte <script>alert(1)</script>`, quantity: 1, unit_price: 60, total: 60 },
    ],
  });
  const html = renderTicketEmail({ visit, cycleVisits: null, requiredVisits: null });
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test("render: visita sin items muestra solo TOTAL (como el ticket)", () => {
  const html = renderTicketEmail({ visit: baseVisit({ items: null }), cycleVisits: 1, requiredVisits: 7 });
  assert.match(html, /TOTAL/);
  assertNoFakeData(html);
});