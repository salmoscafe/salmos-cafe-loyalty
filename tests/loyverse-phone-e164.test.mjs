// ---------------------------------------------------------------
// loyverse-phone-e164.test.mjs — bug de doble +52 en loyverseCore.
//
// Antes: createOrLinkLoyverseCustomer pasaba a computeIdentityUpdates
// el teléfono YA reducido a dígitos ("526645550000") y toE164 le
// anteponía otro 52 → "+52526645550000": rellenos corruptos en Loyverse
// e identity_conflict falso contra un cliente con el MISMO teléfono.
// Ahora: computeIdentityUpdates recibe el teléfono original y toE164
// trata "52 + 10 dígitos" sin "+" como ya country-coded. La búsqueda
// (listByPhone) sigue recibiendo dígitos.
// ---------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toE164,
  computeIdentityUpdates,
  createOrLinkLoyverseCustomer,
} from "../supabase/functions/_shared/loyverseCore.js";

const APP_PHONE = "+526645550000";
const DOUBLE = /^\+5252\d{10}$/; // +52 + 52 + 10 dígitos nacionales

// ------------------------------ toE164 ------------------------------
test("toE164: las tres formas equivalentes producen el mismo E.164", () => {
  assert.equal(toE164("6645550000"), "+526645550000");
  assert.equal(toE164("+526645550000"), "+526645550000");
  assert.equal(toE164("526645550000"), "+526645550000");
  assert.equal(toE164("+52 664 555 0000"), "+526645550000");
  assert.equal(toE164("52 (664) 555-0000"), "+526645550000");
  assert.equal(toE164("664-555-0000"), "+526645550000");
});

test("toE164: ningún teléfono MX válido produce +5252… (doble código de país)", () => {
  const nationals = ["6645550000", "5512345678", "3312345678", "8112345678", "9981234567"];
  for (const n of nationals) {
    for (const input of [n, `52${n}`, `+52${n}`, `+52 ${n}`, `52-${n}`]) {
      const out = toE164(input);
      assert.equal(out, `+52${n}`, input);
      assert.equal(DOUBLE.test(out), false, `doble +52 con ${input}`);
      assert.match(out, /^\+52\d{10}$/);
    }
  }
});

test("toE164: comportamiento previo intacto para otros países y entradas vacías", () => {
  assert.equal(toE164("+16641234567"), "+16641234567");
  assert.equal(toE164(""), null);
  assert.equal(toE164(null), null);
  assert.equal(toE164("abc"), null);
});

// ------------------------- computeIdentityUpdates -------------------------
test("computeIdentityUpdates: app +526645550000 y Loyverse sin teléfono → relleno exacto +526645550000", () => {
  const { fills, block } = computeIdentityUpdates({
    name: "Ana",
    email: "ana@example.com",
    phone: APP_PHONE,
    customerCode: "SC-AAAAAAAA",
    loyverse: { id: "lv", name: "Ana", email: "ana@example.com", phone_number: null },
  });
  assert.equal(fills.phone_number, "+526645550000");
  assert.notEqual(fills.phone_number, "+52526645550000");
  assert.deepEqual(block, []);
});

test("computeIdentityUpdates: el mismo número en cualquier formato en Loyverse no genera conflicto", () => {
  for (const lvPhone of ["+526645550000", "6645550000", "526645550000", "+52 664 555 0000"]) {
    const { fills, block } = computeIdentityUpdates({
      phone: APP_PHONE,
      loyverse: { id: "lv", phone_number: lvPhone },
    });
    assert.deepEqual(block, [], `Loyverse=${lvPhone}`);
    assert.equal("phone_number" in fills, false, "no se sobrescribe ni rellena un teléfono existente");
  }
});

test("computeIdentityUpdates: un número DISTINTO sigue bloqueando (identity_conflict)", () => {
  const { block } = computeIdentityUpdates({ phone: APP_PHONE, loyverse: { id: "lv", phone_number: "+526649999999" } });
  assert.deepEqual(block, ["phone"]);
});

// ------------------- Orquestación completa (create / update / search) -------------------
function makeTransport(customers = []) {
  const calls = [];
  return {
    calls,
    async listByEmail(email) {
      calls.push(["listByEmail", email]);
      return customers.filter((c) => c.email === email);
    },
    async listByPhone(digits) {
      calls.push(["listByPhone", digits]);
      return customers.filter((c) => String(c.phone_number || "").replace(/\D/g, "") === digits);
    },
    async create(payload) {
      calls.push(["create", payload]);
      return { id: "lv-new", ...payload };
    },
    async update(id, payload) {
      calls.push(["update", id, payload]);
      return { id };
    },
  };
}

test("vincular: Loyverse con el MISMO teléfono E.164 ya no da identity_conflict falso", async () => {
  const t = makeTransport([{ id: "lv-1", name: "Ana", email: "ana@example.com", phone_number: "+526645550000" }]);
  const r = await createOrLinkLoyverseCustomer({ transport: t, name: "Ana", email: "ana@example.com", phone: APP_PHONE, customerCode: "SC-AAAAAAAA" });
  assert.notEqual(r.status, "conflict", JSON.stringify(r.audit));
  assert.equal(r.loyverseCustomerId, "lv-1");
  const update = t.calls.find((c) => c[0] === "update");
  assert.equal(update?.[2]?.phone_number, undefined, "no reescribe el teléfono existente");
});

test("vincular: Loyverse sin teléfono → PUT con phone_number exactamente +526645550000", async () => {
  const t = makeTransport([{ id: "lv-1", name: "Ana", email: "ana@example.com", phone_number: null }]);
  const r = await createOrLinkLoyverseCustomer({ transport: t, name: "Ana", email: "ana@example.com", phone: APP_PHONE, customerCode: "SC-AAAAAAAA" });
  assert.equal(r.status, "updated");
  const update = t.calls.find((c) => c[0] === "update");
  assert.equal(update[2].phone_number, "+526645550000");
});

test("crear: phone_number exactamente +526645550000 desde E.164, 12 dígitos o 10 dígitos", async () => {
  for (const phone of ["+526645550000", "526645550000", "6645550000"]) {
    const t = makeTransport();
    const r = await createOrLinkLoyverseCustomer({ transport: t, name: "Ana", email: "nueva@example.com", phone, customerCode: "SC-AAAAAAAA" });
    assert.equal(r.status, "created");
    assert.equal(t.calls.find((c) => c[0] === "create")[1].phone_number, "+526645550000", phone);
  }
});

test("búsqueda: listByPhone sigue recibiendo la representación en dígitos", async () => {
  const t = makeTransport();
  await createOrLinkLoyverseCustomer({ transport: t, name: "Ana", email: "x@example.com", phone: APP_PHONE, customerCode: "SC-AAAAAAAA" });
  assert.deepEqual(t.calls.find((c) => c[0] === "listByPhone"), ["listByPhone", "526645550000"]);
});

test("teléfono sin dígitos: no se envía phone_number (ni null) en el relleno", async () => {
  const t = makeTransport([{ id: "lv-1", name: "Ana", email: "ana@example.com", phone_number: null, customer_code: null }]);
  await createOrLinkLoyverseCustomer({ transport: t, name: "Ana", email: "ana@example.com", phone: "sin teléfono", customerCode: "SC-AAAAAAAA" });
  const update = t.calls.find((c) => c[0] === "update");
  assert.equal(update && "phone_number" in update[2], false);
});
