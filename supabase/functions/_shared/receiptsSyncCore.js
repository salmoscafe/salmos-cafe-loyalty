// ---------------------------------------------------------------
// receiptsSyncCore — Lógica pura de la Edge Function `loyverse-receipts-sync`.
//
// Es 100% agnóstico del transporte: NO toca Supabase, NO lee secrets,
// NO llama a la red ni a Loyverse, NO importa Deno. Por eso es
// unit-testable con `node --test` (ver tests/receipts-sync-core.test.mjs).
//
// Fuente de verdad de la API (Loyverse v1.0, confirmado en vivo):
//   GET /v1.0/receipts?limit&cursor&updated_at_min&updated_at_max&store_id
//   → { receipts: [ { receipt_number, created_at, updated_at, receipt_date,
//       cancelled_at, total_money, customer_id, employee_id, store_id,
//       pos_device_id, line_items, payments } ], cursor? }
//   El receipt real NO trae campo `id`: la clave de idempotencia es
//     external_sale_id = `loyverse_receipt_${store_id}_${receipt_number}`
//   (formato decidido con el socio; determinístico y estable).
//
// Reglas que se deciden AQUÍ (la primera barrera) y que las RPC de
// PostgreSQL vuelven a forzar (segunda barrera):
//   * receipt sin customer_id                → ignorar (no_customer).
//   * receipt cancelado                      → cancelar la visita (si
//     existió) / no-op (si nunca se registró).
//   * receipt con total_money < $50 MXN      → ignorar (below_minimum).
//   * cliente de Loyverse NO mapeado a Salmos → ignorar (unmapped_customer);
//     NUNCA se auto-crea un cliente ni una visita sin mapear.
//   * resto                                  → registrar visita.
//   La fecha de negocio se deriva del receipt (receipt_date/created_at)
//   en America/Tijuana (BUSINESS_TIMEZONE de loyaltyEngineCore): NUNCA
//   UTC, NUNCA el reloj del llamador.
//
// Contrato con la migración 0007_loyverse_receipts_sync.sql:
//   register_visit(uuid, text, numeric, date, text, text, text, text, text)
//   cancel_visit_by_sale(text, text, text)
// ---------------------------------------------------------------

import { getBusinessDate, BUSINESS_TIMEZONE } from "./loyaltyEngineCore.js";

// Importante: la fuente única de la regla de negocio $50 MXN es la BD
// (CHECK de loyalty_visits + register_visit). Este valor ES la copia de
// diagnóstico para NO llamar al RPC con datos que sabemos que va a
// rechazar; si cambia en la BD, hay que alinearlo aquí.
export const MINIMUM_VISIT_AMOUNT = 50;

// source con el que se registran las visitas del POS.
export const SOURCE_LOYVERSE = "loyverse";

// Actor fijo del pipeline. La Edge corre con service_role (sin JWT de
// usuario), así que assert_loyalty_actor acepta actor_role='system'.
export const SYNC_ACTOR = Object.freeze({
  actorId: "loyverse-receipts-sync",
  actorRole: "system",
});

// ---------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------

// total_money puede venir como número, string numérico o { amount, ... }.
export function normalizeMoney(value) {
  if (value == null) return null;
  if (typeof value === "object") value = value.amount;
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// Clave de idempotencia determinística. El formato real del receipt no
// tiene `id`, así que se compone con los campos estables del recibo.
export function buildExternalSaleId({ store_id, receipt_number }) {
  if (typeof store_id !== "string" || store_id.trim() === "") {
    throw new TypeError("store_id es requerido para el external_sale_id.");
  }
  if (typeof receipt_number !== "string" || receipt_number.trim() === "") {
    throw new TypeError("receipt_number es requerido para el external_sale_id.");
  }
  return `loyverse_receipt_${store_id}_${receipt_number}`;
}

// Fecha de negocio del receipt en America/Tijuana (receipt_date primero,
// created_at como respaldo). Una fecha inválida NO aborta el pipeline:
// cae a la fecha de negocio actual (diagnóstico en la corrida).
export function buildVisitDate(receipt, { timezone = BUSINESS_TIMEZONE } = {}) {
  const ts = receipt?.receipt_date ?? receipt?.created_at ?? null;
  let date;
  if (ts != null && ts !== "") {
    date = new Date(ts);
    if (Number.isNaN(date.getTime())) date = new Date();
  } else {
    date = new Date();
  }
  return getBusinessDate(date, timezone);
}

// ---------------------------------------------------------------
// Clasificación del receipt (caso A–D de la especificación)
// ---------------------------------------------------------------
export function isCancelledReceipt(receipt) {
  return Boolean(receipt?.cancelled_at != null && receipt.cancelled_at !== "");
}

// Devuelve { kind } donde kind ∈:
//   'no_customer'   → sin customer_id: nada que registrar/cancelar.
//   'cancelled'     → refund/cancelado: cancelar la visita si existió.
//   'below_minimum' → < $50 MXN: no genera visita.
//   'register'      → visita válida a registrar.
//   'invalid'       → receipt malformado (falta store_id/receipt_number/
//                     monto inparseable): DIAGNÓSTICO, nunca se silencia.
// Para 'below_minimum'/'register' se adjunta `amount` normalizado.
export function classifyReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") {
    return { kind: "invalid", reason: "missing_receipt" };
  }

  const customerId = receipt.customer_id ?? null;
  if (typeof customerId !== "string" || customerId.trim() === "") {
    return { kind: "no_customer" };
  }

  if (typeof receipt.store_id !== "string" || receipt.store_id.trim() === "") {
    return { kind: "invalid", reason: "missing_store_id" };
  }
  if (typeof receipt.receipt_number !== "string" || receipt.receipt_number.trim() === "") {
    return { kind: "invalid", reason: "missing_receipt_number" };
  }

  const amount = normalizeMoney(receipt.total_money);
  if (amount == null) {
    return { kind: "invalid", reason: "invalid_amount" };
  }

  if (isCancelledReceipt(receipt)) {
    return { kind: "cancelled", amount };
  }
  if (amount < MINIMUM_VISIT_AMOUNT) {
    return { kind: "below_minimum", amount };
  }
  return { kind: "register", amount };
}

// ---------------------------------------------------------------
// Mapeo de clientes (customers.loyverse_customer_id). NUNCA auto-crear.
// ---------------------------------------------------------------
export function buildCustomerMap(customers) {
  const map = new Map();
  for (const customer of customers || []) {
    const loyverseId = customer?.loyverse_customer_id;
    if (typeof loyverseId === "string" && loyverseId.trim() !== "" && customer?.id) {
      map.set(loyverseId, customer);
    }
  }
  return map;
}

export function resolveCustomer(customerMap, receipt) {
  const customerId = receipt?.customer_id ?? null;
  if (typeof customerId !== "string") return null;
  return customerMap.get(customerId) || null;
}

// ---------------------------------------------------------------
// Argumentos EXACTOS de las RPCs de 0007 (firmas de 0005).
// ---------------------------------------------------------------
export function buildRegisterVisitArgs({ receipt, customer, externalSaleId, visitDate }) {
  return {
    p_customer_id: customer.id,
    p_external_sale_id: externalSaleId,
    p_amount: normalizeMoney(receipt.total_money),
    p_visit_date: visitDate,
    p_store_id: receipt.store_id ?? null,
    p_employee_id: receipt.employee_id ?? null,
    p_source: SOURCE_LOYVERSE,
    p_actor_id: SYNC_ACTOR.actorId,
    p_actor_role: SYNC_ACTOR.actorRole,
  };
}

export function buildCancelArgs({ externalSaleId }) {
  return {
    p_external_sale_id: externalSaleId,
    p_actor_id: SYNC_ACTOR.actorId,
    p_actor_role: SYNC_ACTOR.actorRole,
  };
}

// ---------------------------------------------------------------
// Decisión por receipt (orquestable desde la Edge y testeable aquí)
// ---------------------------------------------------------------
// Devuelve:
//   { action: 'register', externalSaleId, visitDate, registerArgs }
//   { action: 'cancel',   externalSaleId, cancelArgs }
//   { action: 'ignore',   externalSaleId, reason: 'no_customer' |
//                         'below_minimum' | 'unmapped_customer' | <invalid-reason> }
export function decideReceiptAction({ receipt, customerMap }) {
  const classification = classifyReceipt(receipt);

  if (classification.kind === "invalid") {
    return { action: "ignore", reason: classification.reason, externalSaleId: null };
  }

  const externalSaleId = buildExternalSaleId(receipt);

  if (classification.kind === "no_customer") {
    return { action: "ignore", reason: "no_customer", externalSaleId };
  }
  if (classification.kind === "below_minimum") {
    return { action: "ignore", reason: "below_minimum", externalSaleId, amount: classification.amount };
  }
  if (classification.kind === "cancelled") {
    return { action: "cancel", externalSaleId, cancelArgs: buildCancelArgs({ externalSaleId }) };
  }

  // register
  const customer = resolveCustomer(customerMap, receipt);
  if (!customer) {
    return { action: "ignore", reason: "unmapped_customer", externalSaleId };
  }

  const visitDate = buildVisitDate(receipt);
  return {
    action: "register",
    externalSaleId,
    visitDate,
    registerArgs: buildRegisterVisitArgs({ receipt, customer, externalSaleId, visitDate }),
  };
}

// ---------------------------------------------------------------
// Agrupación de decisiones por página (diagnóstico de corrida).
// ---------------------------------------------------------------
// Devuelve { decisions: [...], summary: { count, registered, cancelled,
// noCustomer, belowMinimum, unmappedCustomer, invalid } } — puro, sin I/O.
export function decidePage({ receipts, customerMap }) {
  const decisions = (receipts || []).map((receipt) => decideReceiptAction({ receipt, customerMap }));
  const summary = { count: decisions.length, registered: 0, cancelled: 0, noCustomer: 0, belowMinimum: 0, unmappedCustomer: 0, invalid: 0 };
  for (const decision of decisions) {
    switch (decision.action) {
      case "register":
        summary.registered++;
        break;
      case "cancel":
        summary.cancelled++;
        break;
      case "ignore":
        if (decision.reason === "no_customer") summary.noCustomer++;
        else if (decision.reason === "below_minimum") summary.belowMinimum++;
        else if (decision.reason === "unmapped_customer") summary.unmappedCustomer++;
        else summary.invalid++;
        break;
    }
  }
  return { decisions, summary };
}