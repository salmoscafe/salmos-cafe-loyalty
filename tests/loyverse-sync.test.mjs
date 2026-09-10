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

// 2. Cliente existe por email → se vincula sin crear.
test("email ya existente se vincula (sin crear)", async () => {
  const { store, transport } = makeStore([
    { id: "lv_1", name: "Javier Castro", email: "javier@example.com", phone_number: "+521234567890" },
  ]);
  const result = await createOrLinkLoyverseCustomer({ transport, ...baseProfile() });
  assert.equal(result.status, "linked");
  assert.equal(result.loyverseCustomerId, "lv_1");
  assert.equal(result.audit.via, "email");
  assert.ok(!transport._calls.some((c) => c.op === "create"));
});

// 3. No existe por email pero sí por teléfono (la API no filtra por teléfono).
test("telefono existente: se pagina/lista y vincula via phone", async () => {
  const { store, transport } = makeStore([
    { id: "lv_1", name: "Mara Salinas", email: "mara@example.com" },
    { id: "lv_2", name: "Otro", email: "otro@example.com" },
    { id: "lv_3", name: "Otro2", email: "otro2@example.com" },
    { id: "lv_4", name: "Otro3", email: "otro3@example.com" },
    { id: "lv_5", name: "Otro4", email: "otro4@example.com" },
    { id: "lv_6", name: "Cliente Telefono", phone_number: "6641234567" },
  ]);
  const result = await createOrLinkLoyverseCustomer({
    transport,
    ...baseProfile({ email: null, phone: "6641234567" }),
  });
  assert.equal(result.status, "linked");
  assert.equal(result.loyverseCustomerId, "lv_6");
  assert.equal(result.audit.via, "phone");
  assert.ok(transport._calls.some((c) => c.op === "listByPhone"));
  assert.ok(!transport._calls.some((c) => c.op === "create"));
});

// 4. Email y teléfono apuntan al MISMO cliente → linked, via email_and_phone.
test("email y telefono del mismo cliente se vinculan una sola vez", async () => {
  const { store, transport } = makeStore([
    { id: "lv_1", name: "Javier Castro", email: "javier@example.com", phone_number: "6641234567" },
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