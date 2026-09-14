// Suite de la lógica pura del sync de receipts Loyverse (Fase D2-v1).
// Importa DIRECTAMENTE supabase/functions/_shared/receiptsSyncCore.js
// (sin Deno, sin Supabase, sin red): el core es puro e importable desde
// Node. Corre con: `node --test "tests/*.test.mjs"` (ver package.json).
//
// Cubre:
//   * external_sale_id determinístico (sin campo `id` en la API real)
//   * clasificación de receipts (casos A–D + malformados)
//   * fecha de negocio America/Tijuana derivada del receipt
//   * mapeo customers.loyverse_customer_id (nunca auto-crear)
//   * argumentos EXACTOS de register_visit / cancel_visit_by_sale

import test from "node:test";
import assert from "node:assert/strict";

import { getBusinessDate } from "../supabase/functions/_shared/loyaltyEngineCore.js";
import {
  MINIMUM_VISIT_AMOUNT,
  SOURCE_LOYVERSE,
  SYNC_ACTOR,
  buildCancelArgs,
  buildCustomerMap,
  buildExternalSaleId,
  buildRegisterVisitArgs,
  buildVisitDate,
  classifyReceipt,
  decidePage,
  decideReceiptAction,
  isCancelledReceipt,
  normalizeMoney,
  resolveCustomer,
} from "../supabase/functions/_shared/receiptsSyncCore.js";

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function makeReceipt(overrides = {}) {
  return {
    receipt_number: "1-0002",
    created_at: "2026-09-12T07:05:00Z",
    updated_at: "2026-09-12T07:05:00Z",
    receipt_date: "2026-09-12T07:05:00Z",
    cancelled_at: null,
    total_money: 120,
    customer_id: "lv_customer_1",
    employee_id: "emp-1",
    store_id: "store-tj-1",
    pos_device_id: "dev-1",
    line_items: [],
    payments: [],
    ...overrides,
  };
}

function makeCustomerMap() {
  return buildCustomerMap([
    { id: "cust-a", loyverse_customer_id: "lv_customer_1" },
    { id: "cust-b", loyverse_customer_id: "lv_customer_2" },
    { id: "cust-no-loyverse" }, // sin vínculo: nunca entra al mapa
  ]);
}

// ---------------------------------------------------------------
// buildExternalSaleId — formato decidido con el socio
// ---------------------------------------------------------------
test("buildExternalSaleId: formato loyverse_receipt_<store>_<number>", () => {
  const id = buildExternalSaleId({ store_id: "e0f3ae87-12b2-41e3-a6ab-8ca0ee1ceb40", receipt_number: "1-0002" });
  assert.equal(id, "loyverse_receipt_e0f3ae87-12b2-41e3-a6ab-8ca0ee1ceb40_1-0002");
});

test("buildExternalSaleId: lanza sin store_id o sin receipt_number", () => {
  assert.throws(() => buildExternalSaleId({ receipt_number: "1-0002" }), TypeError);
  assert.throws(() => buildExternalSaleId({ store_id: "s-1" }), TypeError);
  assert.throws(() => buildExternalSaleId({ store_id: "", receipt_number: "1-0002" }), TypeError);
});

// ---------------------------------------------------------------
// normalizeMoney / isCancelledReceipt
// ---------------------------------------------------------------
test("normalizeMoney: número, string, comas y objeto {amount}", () => {
  assert.equal(normalizeMoney(150), 150);
  assert.equal(normalizeMoney("150.00"), 150);
  assert.equal(normalizeMoney("1,234.50"), 1234.5);
  assert.equal(normalizeMoney({ amount: 80, currency: "MXN" }), 80);
  assert.equal(normalizeMoney(null), null);
  assert.equal(normalizeMoney("no-es-numero"), null);
  assert.equal(normalizeMoney(undefined), null);
});

test("isCancelledReceipt: verdadero solo con cancelled_at presente", () => {
  assert.equal(isCancelledReceipt(makeReceipt()), false);
  assert.equal(isCancelledReceipt(makeReceipt({ cancelled_at: "2026-09-13T01:00:00Z" })), true);
  assert.equal(isCancelledReceipt(makeReceipt({ cancelled_at: "" })), false);
});

// ---------------------------------------------------------------
// classifyReceipt — casos A–D
// ---------------------------------------------------------------
test("clasificacion: receipt sin customer_id -> no_customer (caso 1-0003)", () => {
  const cls = classifyReceipt(makeReceipt({ customer_id: null, total_money: 50 }));
  assert.equal(cls.kind, "no_customer");
});

test("clasificacion: receipt cancelado -> cancelled (caso 1-0001)", () => {
  const cls = classifyReceipt(makeReceipt({ receipt_number: "1-0001", cancelled_at: "2026-09-13T01:00:00Z", total_money: 50 }));
  assert.equal(cls.kind, "cancelled");
});

test("clasificacion: monto < 50 -> below_minimum", () => {
  assert.equal(classifyReceipt(makeReceipt({ total_money: 49.99 })).kind, "below_minimum");
  assert.equal(classifyReceipt(makeReceipt({ total_money: 0 })).kind, "below_minimum");
});

test("clasificacion: monto >= 50 y vigente -> register (caso 1-0002)", () => {
  const cls = classifyReceipt(makeReceipt({ receipt_number: "1-0002", total_money: 50 }));
  assert.equal(cls.kind, "register");
  assert.equal(cls.amount, 50);
  assert.equal(MINIMUM_VISIT_AMOUNT, 50, "regla mínima alineada con RPC/CHECK");
});

test("clasificacion: cancelado tiene prioridad sobre below_minimum", () => {
  const cls = classifyReceipt(makeReceipt({ cancelled_at: "2026-09-13T01:00:00Z", total_money: 30 }));
  assert.equal(cls.kind, "cancelled");
});

test("clasificacion: sin customer_id tiene prioridad (nada que cancelar si nunca se registró)", () => {
  const cls = classifyReceipt(makeReceipt({ customer_id: null, cancelled_at: "2026-09-13T01:00:00Z" }));
  assert.equal(cls.kind, "no_customer");
});

test("clasificacion: receipts malformados -> invalid con razon", () => {
  assert.equal(classifyReceipt(null).reason, "missing_receipt");
  assert.equal(classifyReceipt(makeReceipt({ store_id: null })).reason, "missing_store_id");
  assert.equal(classifyReceipt(makeReceipt({ receipt_number: "" })).reason, "missing_receipt_number");
  assert.equal(classifyReceipt(makeReceipt({ total_money: "abc" })).reason, "invalid_amount");
});

// ---------------------------------------------------------------
// Fecha de negocio America/Tijuana derivada del receipt
// ---------------------------------------------------------------
test("visitDate: receipt_date en Tijuana cruza medianoche UTC correctamente", () => {
  // 2026-09-12T06:30Z == 23:30 PDT del 11-sep → día de negocio 11.
  assert.equal(buildVisitDate(makeReceipt({ receipt_date: "2026-09-12T06:30:00Z" })), "2026-09-11");
  // 2026-09-12T07:05Z == 00:05 PDT del 12-sep → día de negocio 12.
  assert.equal(buildVisitDate(makeReceipt({ receipt_date: "2026-09-12T07:05:00Z" })), "2026-09-12");
});

test("visitDate: usa created_at como respaldo si falta receipt_date", () => {
  assert.equal(buildVisitDate(makeReceipt({ receipt_date: null, created_at: "2026-09-12T07:05:00Z" })), "2026-09-12");
});

test("visitDate: fecha inválida no aborta, cae a la fecha de negocio actual", () => {
  const got = buildVisitDate(makeReceipt({ receipt_date: "no-es-fecha" }));
  assert.equal(got, getBusinessDate(new Date()));
});

test("visitDate: negocio sin receipt_date ni created_at cae a hoy", () => {
  const got = buildVisitDate(makeReceipt({ receipt_date: null, created_at: null }));
  assert.equal(got, getBusinessDate(new Date()));
});

// ---------------------------------------------------------------
// customerMap — mapeo por loyverse_customer_id, nunca auto-crear
// ---------------------------------------------------------------
test("buildCustomerMap/resolveCustomer: mapea solo clientes vinculados", () => {
  const map = makeCustomerMap();
  assert.equal(resolveCustomer(map, makeReceipt({ customer_id: "lv_customer_1" })).id, "cust-a");
  assert.equal(map.get("lv_customer_1").id, "cust-a");
  assert.equal(map.has("cust-no-loyverse"), false, "sin loyverse_customer_id no entra");
  assert.equal(resolveCustomer(map, makeReceipt({ customer_id: "lv_desconocido" })), null);
  assert.equal(resolveCustomer(map, makeReceipt({ customer_id: null })), null);
});

// ---------------------------------------------------------------
// decideReceiptAction
// ---------------------------------------------------------------
test("decideReceiptAction: registra receipt valido con args EXACTOS de register_visit", () => {
  const customerMap = makeCustomerMap();
  const receipt = makeReceipt({ receipt_number: "1-0002", total_money: 120 });
  const decision = decideReceiptAction({ receipt, customerMap });

  assert.equal(decision.action, "register");
  assert.equal(decision.externalSaleId, "loyverse_receipt_store-tj-1_1-0002");
  assert.equal(decision.visitDate, "2026-09-12");

  assert.deepEqual(decision.registerArgs, {
    p_customer_id: "cust-a",
    p_external_sale_id: "loyverse_receipt_store-tj-1_1-0002",
    p_amount: 120,
    p_visit_date: "2026-09-12",
    p_store_id: "store-tj-1",
    p_employee_id: "emp-1",
    p_source: SOURCE_LOYVERSE,
    p_actor_id: SYNC_ACTOR.actorId,
    p_actor_role: SYNC_ACTOR.actorRole,
  });
  assert.equal(decision.registerArgs.p_source, "loyverse");
  assert.equal(decision.registerArgs.p_actor_role, "system");
});

test("decideReceiptAction: cliente Loyverse sin mapeo -> ignore unmapped_customer", () => {
  const decision = decideReceiptAction({ receipt: makeReceipt({ customer_id: "lv_otro" }), customerMap: makeCustomerMap() });
  assert.deepEqual(decision, { action: "ignore", reason: "unmapped_customer", externalSaleId: "loyverse_receipt_store-tj-1_1-0002" });
});

test("decideReceiptAction: no_customer y below_minimum -> ignore", () => {
  const map = makeCustomerMap();
  const noCustomer = decideReceiptAction({ receipt: makeReceipt({ customer_id: null }), customerMap: map });
  assert.deepEqual(noCustomer, { action: "ignore", reason: "no_customer", externalSaleId: "loyverse_receipt_store-tj-1_1-0002" });

  const low = decideReceiptAction({ receipt: makeReceipt({ total_money: 30 }), customerMap: map });
  assert.equal(low.action, "ignore");
  assert.equal(low.reason, "below_minimum");
  assert.equal(low.amount, 30);
});

test("decideReceiptAction: cancelado -> action cancel con args EXACTOS de cancel_visit_by_sale", () => {
  const map = makeCustomerMap();
  const decision = decideReceiptAction({
    receipt: makeReceipt({ cancelled_at: "2026-09-13T01:00:00Z", total_money: 50 }),
    customerMap: map,
  });
  assert.equal(decision.action, "cancel");
  assert.deepEqual(decision.cancelArgs, {
    p_external_sale_id: "loyverse_receipt_store-tj-1_1-0002",
    p_actor_id: SYNC_ACTOR.actorId,
    p_actor_role: SYNC_ACTOR.actorRole,
  });
});

test("decideReceiptAction: malformado -> ignore con reason, sin externalSaleId", () => {
  const decision = decideReceiptAction({ receipt: makeReceipt({ store_id: "" }), customerMap: makeCustomerMap() });
  assert.deepEqual(decision, { action: "ignore", reason: "missing_store_id", externalSaleId: null });
});

test("buildCancelArgs: firma cancel_visit_by_sale(text,text,text)", () => {
  assert.deepEqual(buildCancelArgs({ externalSaleId: "loyverse_receipt_s_t" }), {
    p_external_sale_id: "loyverse_receipt_s_t",
    p_actor_id: "loyverse-receipts-sync",
    p_actor_role: "system",
  });
});

test("buildRegisterVisitArgs: usa null en opcionales ausentes", () => {
  const args = buildRegisterVisitArgs({
    receipt: makeReceipt({ store_id: null, employee_id: null }),
    customer: { id: "cust-a" },
    externalSaleId: "loyverse_receipt__1-0002",
    visitDate: "2026-09-12",
  });
  assert.equal(args.p_store_id, null);
  assert.equal(args.p_employee_id, null);
});

// ---------------------------------------------------------------
// decidePage — agrupación por página
// ---------------------------------------------------------------
test("decidePage: resume correctamente una página mixta", () => {
  const map = makeCustomerMap();
  const page = [
    // cancelado real del laboratorio (1-0001)
    makeReceipt({ receipt_number: "1-0001", cancelled_at: "2026-09-13T01:00:00Z", total_money: 50 }),
    // válido real del laboratorio (1-0002)
    makeReceipt({ receipt_number: "1-0002", total_money: 50 }),
    // sin customer real del laboratorio (1-0003)
    makeReceipt({ receipt_number: "1-0003", customer_id: null, total_money: 50 }),
    makeReceipt({ total_money: 30 }),
    makeReceipt({ customer_id: "lv_sin_mapear" }),
    makeReceipt({ store_id: null }),
  ];

  const { decisions, summary } = decidePage({ receipts: page, customerMap: map });

  assert.equal(summary.count, 6);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.registered, 1);
  assert.equal(summary.noCustomer, 1);
  assert.equal(summary.belowMinimum, 1);
  assert.equal(summary.unmappedCustomer, 1);
  assert.equal(summary.invalid, 1);

  assert.equal(decisions[0].action, "cancel");
  assert.equal(decisions[1].action, "register");
  assert.equal(decisions[2].action, "ignore");
  assert.equal(decisions[2].reason, "no_customer");
  assert.equal(decisions[3].reason, "below_minimum");
  assert.equal(decisions[4].reason, "unmapped_customer");
  assert.equal(decisions[5].reason, "missing_store_id");
});

test("decidePage: página vacía no rompe el summary", () => {
  const { decisions, summary } = decidePage({ receipts: [], customerMap: makeCustomerMap() });
  assert.deepEqual(decisions, []);
  assert.equal(summary.count, 0);
});