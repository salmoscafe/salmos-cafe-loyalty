import { test } from "node:test";
import assert from "node:assert/strict";

import {
  visitSortTimestamp,
  compareVisitsDesc,
} from "../src/services/sales/saleOrdering.js";
import { computeCycleProgress } from "../src/services/sales/salesService.js";

test("visitSortTimestamp prefiere receiptDate sobre createdAt", () => {
  const sale = {
    createdAt: "2026-01-01T00:00:00.000Z",
    receiptDate: "2026-01-05T00:00:00.000Z",
  };
  assert.equal(
    visitSortTimestamp(sale),
    new Date(sale.receiptDate).getTime()
  );
});

test("visitSortTimestamp usa visitDate como fallback (sin receiptDate)", () => {
  const sale = { createdAt: "2026-01-03T00:00:00.000Z", visitDate: "2026-01-02T00:00:00.000Z" };
  assert.equal(
    visitSortTimestamp(sale),
    new Date(sale.visitDate).getTime()
  );
});

test("visitSortTimestamp usa createdAt solo como fallback (sin receiptDate ni visitDate)", () => {
  const sale = { createdAt: "2026-01-03T00:00:00.000Z" };
  assert.equal(
    visitSortTimestamp(sale),
    new Date(sale.createdAt).getTime()
  );
});

test("visitSortTimestamp: prioridad receiptDate > visitDate > createdAt", () => {
  const sale = {
    createdAt: "2026-01-01T00:00:00.000Z",
    visitDate: "2026-01-02T00:00:00.000Z",
    receiptDate: "2026-01-05T00:00:00.000Z",
  };
  assert.equal(
    visitSortTimestamp(sale),
    new Date(sale.receiptDate).getTime()
  );
});

test("visitSortTimestamp devuelve 0 para datos ausentes/inválidos", () => {
  assert.equal(visitSortTimestamp({}), 0);
  assert.equal(visitSortTimestamp(null), 0);
  assert.equal(visitSortTimestamp(undefined), 0);
  assert.equal(visitSortTimestamp({ createdAt: "no-una-fecha" }), 0);
  assert.equal(visitSortTimestamp({ receiptDate: "no-una-fecha" }), 0);
  assert.equal(visitSortTimestamp({ visitDate: "no-una-fecha" }), 0);
});

test("compareVisitsDesc ordena más reciente → más antigua por receiptDate", () => {
  const visits = [
    { id: "old", createdAt: "2026-09-10T10:00:00.000Z" },
    { id: "mid", createdAt: "2026-09-11T10:00:00.000Z", receiptDate: "2026-09-12T09:00:00.000Z" },
    { id: "new", createdAt: "2026-09-14T23:00:00.000Z" },
  ];
  const sorted = [...visits].sort(compareVisitsDesc);
  assert.deepEqual(
    sorted.map((v) => v.id),
    ["new", "mid", "old"]
  );
});

test("compareVisitsDesc usa visitDate como fallback de receipt (sin receiptDate)", () => {
  // Sin receipt_date (visita pre-0010), la fecha REAL es visit_date; la
  // sincronización posterior (created_at) no debe dominar el orden.
  const visits = [
    { id: "syncLater", createdAt: "2026-09-15T08:00:00.000Z", visitDate: "2026-09-09T00:00:00.000Z" },
    { id: "ticketNewer", createdAt: "2026-09-10T08:00:00.000Z", visitDate: "2026-09-12T00:00:00.000Z" },
  ];
  const sorted = [...visits].sort(compareVisitsDesc);
  assert.deepEqual(
    sorted.map((v) => v.id),
    ["ticketNewer", "syncLater"]
  );
});

test("compareVisitsDesc: empates en la clave principal quedan estables", () => {
  // Mismo visitDate, misma receiptDate: el orden conserva la posición
  // original del arreglo (Array.prototype.sort es estable en V8).
  const visits = [
    { id: "a", visitDate: "2026-09-12T00:00:00.000Z", createdAt: "2026-09-12T01:00:00.000Z" },
    { id: "b", visitDate: "2026-09-12T00:00:00.000Z", createdAt: "2026-09-12T02:00:00.000Z" },
    { id: "c", visitDate: "2026-09-12T00:00:00.000Z", createdAt: "2026-09-12T03:00:00.000Z" },
  ];
  const sorted = [...visits].sort(compareVisitsDesc);
  assert.deepEqual(
    sorted.map((v) => v.id),
    ["a", "b", "c"]
  );
});

test("compareVisitsDesc: receipt_date manda aunque created_at de sincronización sea posterior", () => {
  // 'comprado' tiene receipt_date anterior pero se sincronizó después:
  // el orden debe usar el ticket real (receipt_date), no created_at.
  const visits = [
    { id: "syncLater", createdAt: "2026-09-15T08:00:00.000Z", receiptDate: "2026-09-09T08:00:00.000Z" },
    { id: "ticketNewer", createdAt: "2026-09-10T08:00:00.000Z", receiptDate: "2026-09-12T08:00:00.000Z" },
  ];
  const sorted = [...visits].sort(compareVisitsDesc);
  assert.deepEqual(
    sorted.map((v) => v.id),
    ["ticketNewer", "syncLater"]
  );
});

test("compareVisitsDesc no muta el arreglo original", () => {
  const visits = [
    { id: "a", createdAt: "2026-09-01T00:00:00.000Z" },
    { id: "b", createdAt: "2026-09-02T00:00:00.000Z" },
  ];
  const copy = [...visits];
  [...visits].sort(compareVisitsDesc);
  assert.deepEqual(visits, copy);
});

test("computeCycleProgress: prioridad receipt_date > visit_date > created_at asigna 1-0759→1, 1-0784→2, 1-0980→3, 1-0997→4", () => {
  // Datos tramados para que solo receipt_date produzca el orden objetivo:
  // - visit_date: 1-0997 es la más antigua → rompería el mapping (d, b, c, a).
  // - created_at: 1-0997 es el más reciente sync → también lo rompería (d, b, c, a).
  // - receipt_date es la ÚNICA que ordena 1-0759 < 1-0784 < 1-0980 < 1-0997.
  const cycle_id = "cycle-hist-001";
  const visits = [
    {
      id: "v-0759",
      cycle_id,
      status: "active",
      external_sale_id: "loyverse_receipt_briceno_1-0759",
      receipt_date: "2026-04-01T10:00:00.000Z",
      visit_date: "2026-04-30",
      created_at: "2026-05-28T10:00:00.000Z",
    },
    {
      id: "v-0784",
      cycle_id,
      status: "active",
      external_sale_id: "loyverse_receipt_briceno_1-0784",
      receipt_date: "2026-04-10T10:00:00.000Z",
      visit_date: "2026-04-10",
      created_at: "2026-05-01T10:00:00.000Z",
    },
    {
      id: "v-0980",
      cycle_id,
      status: "active",
      external_sale_id: "loyverse_receipt_briceno_1-0980",
      receipt_date: "2026-04-20T10:00:00.000Z",
      visit_date: "2026-04-20",
      created_at: "2026-05-15T10:00:00.000Z",
    },
    {
      id: "v-0997",
      cycle_id,
      status: "active",
      external_sale_id: "loyverse_receipt_briceno_1-0997",
      receipt_date: "2026-04-30T10:00:00.000Z",
      visit_date: "2026-04-05",
      created_at: "2026-04-25T10:00:00.000Z",
    },
  ];

  const progress = computeCycleProgress(visits);

  assert.equal(progress.get("v-0759"), 1, "1-0759 debe ser la visita 1");
  assert.equal(progress.get("v-0784"), 2, "1-0784 debe ser la visita 2");
  assert.equal(progress.get("v-0980"), 3, "1-0980 debe ser la visita 3");
  assert.equal(progress.get("v-0997"), 4, "1-0997 debe ser la visita 4");
});

test("computeCycleProgress: usa visit_date como fallback cuando no hay receipt_date", () => {
  // Visitas pre-sync sin receipt_date: el orden correcto viene de visit_date,
  // no de created_at.
  const cycle_id = "cycle-hist-002";
  const visits = [
    {
      id: "v-0500",
      cycle_id,
      status: "active",
      external_sale_id: "loyverse_receipt_briceno_1-0500",
      visit_date: "2026-02-10",
      created_at: "2026-05-10T10:00:00.000Z",
    },
    {
      id: "v-0512",
      cycle_id,
      status: "active",
      external_sale_id: "loyverse_receipt_briceno_1-0512",
      visit_date: "2026-02-12",
      created_at: "2026-05-08T10:00:00.000Z",
    },
  ];

  const progress = computeCycleProgress(visits);

  assert.equal(progress.get("v-0500"), 1);
  assert.equal(progress.get("v-0512"), 2);
});

test("computeCycleProgress: no cuenta visitas no activas en el progreso", () => {
  const cycle_id = "cycle-hist-003";
  const visits = [
    {
      id: "v-cancelled",
      cycle_id,
      status: "cancelled",
      external_sale_id: "loyverse_receipt_briceno_1-0500",
      receipt_date: "2026-02-10T10:00:00.000Z",
      visit_date: "2026-02-10",
      created_at: "2026-05-10T10:00:00.000Z",
    },
    {
      id: "v-active",
      cycle_id,
      status: "active",
      external_sale_id: "loyverse_receipt_briceno_1-0512",
      receipt_date: "2026-02-12T10:00:00.000Z",
      visit_date: "2026-02-12",
      created_at: "2026-05-08T10:00:00.000Z",
    },
  ];

  const progress = computeCycleProgress(visits);

  assert.equal(progress.get("v-cancelled"), 0);
  assert.equal(progress.get("v-active"), 1);
});