// Suite de sincronización Salmos⇄Loyverse.
// Corre la lógica REAL del lado servidor (supabase/functions/_shared/loyverseCore.js)
// contra un transporte emulado de la API de Loyverse con las mismas
// semánticas documentadas: GET /customers?email=... filtra por email,
// GET /customers lista (pagina con cursor) y NO filtra por teléfono
// (se página y se filtra acá). Correr con: node --test tests/

import test from "node:test";
import assert from "node:assert/strict";

import {
  createOrLinkLoyverseCustomer,
  computeIdentityUpdates,
  normalizeEmail,
  normalizePhone,
  toE164,
  resolveLoyverseTarget,
  isDuplicateCustomerCodeError,
} from "../supabase/functions/_shared/loyverseCore.js";

// ---------------------------------------------------------------
// Emulación de la API de Loyverse (semántica fiel).
//   * listByEmail: filtro oficial por email (server-side).
//   * listByPhone: la API NO filtra — se lista y se filtra acá, por
//     dígitos tal y como lo hace la Edge Function real.
//   * create: respeta el upsert por customer_code (400 duplicado).
// ---------------------------------------------------------------
function makeStore(initialCustomers = [], opts = {}) {
  const customers = initialCustomers.map((c) => ({ ...c }));
  const calls = [];
  let emailSearches = 0;

  // `hiddenInFirstPass` simula la carrera del doble submit: el registro
  // aún no estaba visible cuando se hizo la primera búsqueda, pero sí
  // cuando se vuelve a buscar tras el 400 de customer_code.
  const hidden = (c) => opts.hiddenInFirstPass && emailSearches <= 1;

  const transport = {
    _calls: calls,

    async listByEmail(email) {
      emailSearches++;
      calls.push({ op: "listByEmail", email });
      const target = normalizeEmail(email);
      return customers.filter((c) => !hidden(c) && normalizeEmail(c.email) === target);
    },

    async listByPhone(phone) {
      calls.push({ op: "listByPhone", phone });
      const digits = String(phone).replace(/\D/g, "");
      if (!digits) return [];
      return customers.filter(
        (c) => !hidden(c) && String(c.phone_number || "").replace(/\D/g, "") === digits
      );
    },

    async create(payload) {
      calls.push({ op: "create", payload });
      if (customers.some((c) => c.customer_code && c.customer_code === payload.customer_code)) {
        const error = new Error("Loyverse request failed with 400");
        error.status = 400;
        error.body = "customer_code already taken";
        throw error;
      }
      const created = { id: `lv_${customers.length + 1}`, ...payload };
      customers.push(created);
      return created;
    },

    async update(customerId, payload) {
      calls.push({ op: "update", customerId, payload });
      const existing = customers.find((c) => c.id === customerId);
      if (!existing) {
        const error = new Error("Loyverse request failed with 404");
        error.status = 404;
        error.body = "customer not found";
        throw error;
      }
      if (
        payload.customer_code &&
        customers.some((c) => c.customer_code === payload.customer_code && c.id !== customerId)
      ) {
        const error = new Error("Loyverse request failed with 400");
        error.status = 400;
        error.body = "customer_code already taken";
        throw error;
      }
      Object.assign(existing, payload);
      return { ...existing };
    },
  };

  return { store: customers, transport };
}

function baseProfile(overrides = {}) {
  return {
    name: "Javier Castro",
    email: "javier@example.com",
    phone: "6641234567",
    customerCode: "SC-AAAAAAAA",
    ...overrides,
  };
}

// 1. Nuevo cliente Salmos sin cliente en Loyverse → se crea, status created.
test("cliente nuevo se crea en Loyverse con customer_code y E.164", async () => {
  const { transport } = makeStore();
  const result = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(result.status, "created");
  assert.ok(result.loyverseCustomerId);
  const createCall = transport._calls.find((c) => c.op === "create");
  assert.ok(createCall, "debía llamar a create");
  assert.equal(createCall.payload.customer_code, "SC-AAAAAAAA");
  assert.equal(createCall.payload.phone_number, "+526641234567");
  assert.equal(createCall.payload.email, "javier@example.com");
});

// 2. Email coincide pero el teléfono de Loyverse es OTRO número → conflicto
//    conservador de identidad (regla nueva): NO se sobrescribe, se bloquea
//    con `identity_conflict` y se le guía a vincular correo/teléfono.
test("email coincide pero telefono distinto -> conflicto conservador", async () => {
  const { transport } = makeStore([
    { id: "lv_1", name: "Javier Castro", email: "javier@example.com", phone_number: "+521234567890" },
  ]);
  const result = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(result.status, "conflict");
  assert.equal(result.audit.code, "identity_conflict");
  assert.deepEqual(result.audit.fields, ["phone"]);
  assert.ok(!transport._calls.some((c) => c.op === "create"));
  assert.ok(!transport._calls.some((c) => c.op === "update"));
});

// 3. No existe por email pero sí por teléfono (la API no filtra por teléfono).
test("telefono existente: se pagina/lista y vincula via phone", async () => {
  const { store, transport } = makeStore([
    { id: "lv_1", name: "Mara Salinas", email: "mara@example.com" },
    { id: "lv_2", name: "Otro", email: "otro@example.com" },
    { id: "lv_3", name: "Otro2", email: "otro2@example.com" },
    { id: "lv_4", name: "Otro3", email: "otro3@example.com" },
    { id: "lv_5", name: "Otro4", email: "otro4@example.com" },
    { id: "lv_6", name: "Cliente Telefono", phone_number: "6641234567", customer_code: "SC-AAAAAAAA" },
  ]);
  const result = await createOrLinkLoyverseCustomer({
    transport,
    ...baseProfile({ email: null, phone: "6641234567" }),
  });
  assert.equal(result.status, "linked");
  assert.equal(result.loyverseCustomerId, "lv_6");
  assert.equal(result.audit.via, "phone");
  // nombre distinto (no vacío) → se omite y se registra en auditoría.
  assert.deepEqual(result.audit.skippedFields, ["name"]);
  assert.ok(transport._calls.some((c) => c.op === "listByPhone"));
  assert.ok(!transport._calls.some((c) => c.op === "create"));
  assert.ok(!transport._calls.some((c) => c.op === "update"));
});

// 4. Email y teléfono apuntan al MISMO cliente → linked, via email_and_phone.
test("email y telefono del mismo cliente se vinculan una sola vez", async () => {
  const { store, transport } = makeStore([
    { id: "lv_1", name: "Javier Castro", email: "javier@example.com", phone_number: "6641234567", customer_code: "SC-AAAAAAAA" },
  ]);
  const result = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(result.status, "linked");
  assert.equal(result.loyverseCustomerId, "lv_1");
  assert.equal(result.audit.via, "email_and_phone");
  assert.ok(!transport._calls.some((c) => c.op === "create"));
});

// 5. Email apunta a X y teléfono a Y (distintos) → conflicto, no se crea nada.
test("email y telefono apuntan a clientes distintos -> conflicto", async () => {
  const { store, transport } = makeStore([
    { id: "lv_1", name: "A Ana", email: "javier@example.com", phone_number: "6641234111" },
    { id: "lv_7", name: "Javi", phone_number: "6641234567" },
  ]);
  const result = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(result.status, "conflict");
  assert.equal(result.audit.code, "email_phone_conflict");
  assert.ok(!transport._calls.some((c) => c.op === "create"));
});

// 6. Teléfono ambiguo (dos clientes con el mismo número) → conflicto.
test("telefono ambiguo (2+ clientes) -> conflicto", async () => {
  const { store, transport } = makeStore([
    { id: "lv_1", name: "A", phone_number: "6641234567" },
    { id: "lv_2", name: "B", phone_number: "6641234567" },
  ]);
  const result = await createOrLinkLoyverseCustomer({
    transport,
    ...baseProfile({ email: null, phone: "6641234567" }),
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.audit.code, "ambiguous_phone");
  assert.ok(!transport._calls.some((c) => c.op === "create"));
});

// 7. Sin email, teléfono y nombre → no se puede decidir.
test("sin identificadores -> conflict no_identifiers", async () => {
  const { transport } = makeStore();
  const result = await createOrLinkLoyverseCustomer({ transport, name: "", email: null, phone: null });
  assert.equal(result.status, "conflict");
  assert.equal(result.audit.code, "no_identifiers");
});

// 8. Doble submit: crear falla por customer_code duplicado → rebusca y vincula.
test("customer_code duplicado al crear -> rebusca y vincula (idempotente)", async () => {
  const { store, transport } = makeStore(
    [
      {
        id: "lv_1",
        name: "Javier Castro",
        email: "javier@example.com",
        phone_number: "6641234567",
        customer_code: "SC-AAAAAAAA",
      },
    ],
    { hiddenInFirstPass: true }
  );
  const result = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(result.status, "linked");
  assert.equal(result.audit.afterDuplicateCode, true);
  assert.equal(result.loyverseCustomerId, "lv_1");
  assert.equal(store.length, 1, "no se crea un duplicado");
  assert.ok(!transport._calls.some((c) => c.op === "update"), "no hay updates innecesarios");
});

// 9. Ya vinculado (knownLoyverseCustomerId) → already_linked sin llamar a red.
test("perfil ya vinculado -> already_linked sin llamar a la red", async () => {
  let listByEmail = 0;
  const transport = {
    async listByEmail() {
      listByEmail++;
      return [];
    },
    async listByPhone() {
      return [];
    },
    async create() {
      return { id: "lv_new" };
    },
  };
  const result = await createOrLinkLoyverseCustomer({
    transport,
    ...baseProfile(),
    knownLoyverseCustomerId: "lv_9",
  });
  assert.equal(result.status, "already_linked");
  assert.equal(result.loyverseCustomerId, "lv_9");
  assert.equal(listByEmail, 0);
});

// 10. Idempotencia: dos sincronizaciones seguidas producen el mismo vínculo.
test("sincronizar dos veces -> mismo cliente, nunca duplicado", async () => {
  const { store, transport } = makeStore();
  const first = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(first.status, "created");
  const second = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(second.status, "linked");
  assert.equal(first.loyverseCustomerId, second.loyverseCustomerId);
  assert.equal(store.filter((c) => c.email === "javier@example.com").length, 1);
});

// ------------------------------------------------------------------
// Actualización automática de clientes existentes (reglas conservadoras).
//   1) idénticos → no PATCH · 2) faltantes → rellenar · 3) customer_code
//   null → set · 4) diferencia segura → equal · 5/6) email/teléfono
//   distintos → conflicto (nunca sobrescribir) · 7/8) crear/vincular ·
//   9) doble submit → sin updates · 10) campos POS intactos ·
//   11) error al actualizar → se propaga (502 retriable) ·
//   12) auditoría solo si hubo update real.
// ------------------------------------------------------------------

// 1. Todo idéntico (tras normalizar) → linked, sin PATCH.
test("cliente identico: sin update (ni PATCH) y status linked", async () => {
  const { transport } = makeStore([
    { id: "lv_1", name: "Javier Castro", email: "javier@example.com", phone_number: "+526641234567", customer_code: "SC-AAAAAAAA" },
  ]);
  const result = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(result.status, "linked");
  assert.equal(result.audit.updated, false);
  assert.deepEqual(result.audit.skippedFields, []);
  assert.ok(!transport._calls.some((c) => c.op === "update"));
});

// 2. Cliente incompleto en Loyverse → se rellenan SOLO los campos faltantes
//    en UNA actualización (nunca se toca lo que ya coincide).
test("cliente incompleto: rellena solo los campos faltantes (una actualizacion)", async () => {
  const { transport } = makeStore([{ id: "lv_1", email: "javier@example.com" }]);
  const result = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(result.status, "updated");
  assert.equal(result.loyverseCustomerId, "lv_1");
  assert.equal(result.audit.updated, true);
  const update = transport._calls.find((c) => c.op === "update");
  assert.ok(update, "debia llamar a update");
  assert.deepEqual(Object.keys(update.payload).sort(), ["customer_code", "name", "phone_number"]);
  assert.equal(update.payload.email, undefined, "email coincide: no viaja");
  assert.equal(update.payload.name, "Javier Castro");
  assert.equal(update.payload.phone_number, "+526641234567");
  assert.equal(update.payload.customer_code, "SC-AAAAAAAA");
  assert.ok(!transport._calls.some((c) => c.op === "create"));
});

// 3. customer_code null en Loyverse → se establece (solo eso).
test("customer_code faltante en Loyverse -> solo se establece el codigo", async () => {
  const { transport } = makeStore([
    { id: "lv_1", name: "Javier Castro", email: "javier@example.com", phone_number: "+526641234567" },
  ]);
  const result = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(result.status, "updated");
  const update = transport._calls.find((c) => c.op === "update");
  assert.ok(update);
  assert.deepEqual(Object.keys(update.payload), ["customer_code"]);
  assert.equal(update.payload.customer_code, "SC-AAAAAAAA");
});

// 4. "Diferencia segura" (espacios/minúsculas en el email) → equal → no update.
test("diferencia segura (espacios/minusculas en email) no genera update", async () => {
  const { transport } = makeStore([
    { id: "lv_1", name: "Javier Castro", email: "  JAVIER@Example.COM ", phone_number: "+526641234567", customer_code: "SC-AAAAAAAA" },
  ]);
  const result = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(result.status, "linked");
  assert.ok(!transport._calls.some((c) => c.op === "update"));
});

// 5. Email distinto en el cliente existente → conflicto conservador: no se
//    sobrescribe, no se actualiza nada, no se crea nada.
test("email distinto en cliente existente -> conflicto conservador", async () => {
  const { transport } = makeStore([
    { id: "lv_1", name: "Javier Castro", email: "otro@example.com", phone_number: "6641234567", customer_code: "SC-AAAAAAAA" },
  ]);
  const result = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  // resuelto por teléfono; el email difiere → bloque.
  assert.equal(result.status, "conflict");
  assert.equal(result.audit.code, "identity_conflict");
  assert.deepEqual(result.audit.fields, ["email"]);
  assert.ok(!transport._calls.some((c) => c.op === "create"));
  assert.ok(!transport._calls.some((c) => c.op === "update"));
});

// nombre/customer_code distintos (ambos no vacíos) → se omiten y se auditan;
// NO bloquean la vinculación.
test("nombre/customer_code distintos -> se omiten y se auditan (no bloquean)", async () => {
  const { transport } = makeStore([
    { id: "lv_1", name: "Javierito", email: "javier@example.com", phone_number: "+526641234567", customer_code: "SC-OTHER01" },
  ]);
  const result = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(result.status, "linked");
  assert.deepEqual([...result.audit.skippedFields].sort(), ["customer_code", "name"]);
  assert.ok(!transport._calls.some((c) => c.op === "update"));
});

// 10. Los campos derivados del POS NUNCA viajan en el update ni se tocan.
test("campos del POS (total_*) nunca viajan en el update ni se tocan", async () => {
  const { store, transport } = makeStore([
    { id: "lv_1", email: "javier@example.com", name: "Javier Castro", total_visits: 12, total_spent: 600.5, total_points: 30 },
  ]);
  const result = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(result.status, "updated");
  const update = transport._calls.find((c) => c.op === "update");
  for (const forbidden of ["total_visits", "total_spent", "total_points", "receipts"]) {
    assert.ok(!(forbidden in update.payload), `${forbidden} no debe viajar en el update`);
  }
  assert.equal(store[0].total_visits, 12);
  assert.equal(store[0].total_spent, 600.5);
  assert.equal(store[0].total_points, 30);
});

// 11. Error al actualizar → se propaga (la Edge responde 502 retriable y la
//     sesión se entrega igual: patrón de error existente, sin cambios).
test("error al actualizar se propaga (la Edge responde 502 retriable)", async () => {
  const calls = [];
  const transport = {
    async listByEmail() {
      calls.push("listByEmail");
      return [{ id: "lv_1", name: "Javier Castro", email: "javier@example.com" }];
    },
    async listByPhone() {
      calls.push("listByPhone");
      return [];
    },
    async create() {
      calls.push("create");
      return { id: "lv_new" };
    },
    async update() {
      calls.push("update");
      const error = new Error("Loyverse request failed with 500");
      error.status = 500;
      throw error;
    },
  };
  await assert.rejects(createOrLinkLoyverseCustomer({ transport, ...baseProfile() }), /500/);
  assert.ok(calls.includes("update"), "se intento actualizar");
});

// 12. La auditoría (audit.updated true) corresponde SOLO a updates reales.
test("audit.updated es true solo cuando hubo actualizacion real", async () => {
  const { transport: t1 } = makeStore([
    { id: "lv_1", name: "Javier Castro", email: "javier@example.com", phone_number: "+526641234567", customer_code: "SC-AAAAAAAA" },
  ]);
  const same = await createOrLinkLoyverseCustomer({ transport: t1, ...baseProfile() });
  assert.equal(same.status, "linked");
  assert.equal(same.audit.updated, false);
  assert.ok(!t1._calls.some((c) => c.op === "update"));

  const { transport: t2 } = makeStore([{ id: "lv_1", email: "javier@example.com" }]);
  const filled = await createOrLinkLoyverseCustomer({ transport: t2, ...baseProfile() });
  assert.equal(filled.status, "updated");
  assert.equal(filled.audit.updated, true);
  assert.deepEqual([...filled.audit.fields].sort(), ["customer_code", "name", "phone_number"]);
});

// Helpers de normalización.
test("normalization: email, telefono y E.164", () => {
  assert.equal(normalizeEmail("  Javier@Example.COM "), "javier@example.com");
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizePhone("+52 664 123 4567"), "526641234567");
  assert.equal(normalizePhone("(664)123-4567"), "6641234567");
  assert.equal(toE164("6641234567"), "+526641234567");
  assert.equal(toE164("+16641234567"), "+16641234567");
  assert.equal(toE164("", "52"), null);
});

test("resolveLoyverseTarget: casos puros (email/phone/conflict/none)", () => {
  const a = { id: "x", email: "a@x.com" };
  const b = { id: "y", phone_number: "+525555" };
  const same = { id: "x", email: "a@x.com", phone_number: "+525555" };

  assert.equal(resolveLoyverseTarget({ emailMatches: [a] }).status, "linked");
  assert.equal(resolveLoyverseTarget({ emailMatches: [], phoneMatches: [b] }).status, "linked");
  assert.equal(resolveLoyverseTarget({ emailMatches: [], phoneMatches: [b, { id: "z", phone_number: "+525555" }] }).status, "conflict");
  assert.equal(resolveLoyverseTarget({ emailMatches: [a], phoneMatches: [same] }).status, "linked");
  assert.equal(resolveLoyverseTarget({ emailMatches: [a], phoneMatches: [b] }).status, "conflict");
  assert.equal(resolveLoyverseTarget({ emailMatches: [], phoneMatches: [] }).status, "none");
});

test("isDuplicateCustomerCodeError matchea 400 con mensaje/body customer_code", () => {
  assert.equal(isDuplicateCustomerCodeError({ status: 400, message: "customer_code taken" }), true);
  assert.equal(isDuplicateCustomerCodeError({ status: 400, body: '"customer_code" must be unique' }), true);
  assert.equal(isDuplicateCustomerCodeError({ status: 500 }), false);
  assert.equal(isDuplicateCustomerCodeError({ status: 400, message: "email taken" }), false);
});

test("computeIdentityUpdates: matriz de decisiones (fills/block/skipped)", () => {
  const base = { name: "Ana Pérez", email: "ana@example.com", phone: "6641234567", customerCode: "SC-BBBBBBBB" };
  const full = { name: "Ana Pérez", email: "ana@example.com", phone_number: "+526641234567", customer_code: "SC-BBBBBBBB" };

  // idéntico → nada.
  assert.deepEqual(computeIdentityUpdates({ ...base, loyverse: full }), { fills: {}, block: [], skipped: [] });

  // incompleto → rellena los faltantes (E.164 para teléfono).
  assert.deepEqual(computeIdentityUpdates({ ...base, loyverse: { name: "" } }).fills, {
    name: "Ana Pérez",
    email: "ana@example.com",
    phone_number: "+526641234567",
    customer_code: "SC-BBBBBBBB",
  });

  // sin email/teléfono en Salmos → jamás bloquea.
  assert.deepEqual(computeIdentityUpdates({ ...base, email: null, phone: null, loyverse: full }).block, []);

  // distintos → bloquea solo el campo en conflicto.
  assert.deepEqual(computeIdentityUpdates({ ...base, loyverse: { ...full, email: "otra@example.com" } }).block, ["email"]);
  assert.deepEqual(computeIdentityUpdates({ ...base, loyverse: { ...full, phone_number: "+525555555555" } }).block, ["phone"]);

  // nombre/customer_code distintos (no vacíos) → skipped, no bloquea.
  assert.deepEqual(
    computeIdentityUpdates({ ...base, loyverse: { ...full, name: "Ana", customer_code: "SC-XXXXXXXX" } }).skipped.sort(),
    ["customer_code", "name"]
  );

  // los datos del POS presentes en Loyverse no generan fills ni bloqueos.
  assert.deepEqual(computeIdentityUpdates({ ...base, loyverse: { ...full, total_visits: 9, total_spent: 123.45 } }).fills, {});
});