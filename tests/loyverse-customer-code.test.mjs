// ---------------------------------------------------------------
// loyverse-customer-code.test.mjs — integridad del customer_code en
// la Edge `loyverse-customers` (hallazgo 2026-10-07).
//
// Antes: `const customerCode = body.customerCode || profile.customer_code`
// → el cliente podía mandar a Loyverse el código QR de OTRA persona.
// Ahora: resolveTrustedCustomerCode() usa SIEMPRE profile.customer_code
// (fila `customers` del usuario autenticado) y rechaza con 409
// customer_code_mismatch cualquier valor distinto, sin llamar a Loyverse.
// ---------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTrustedCustomerCode } from "../supabase/functions/_shared/loyverseCore.js";
import { runLoyverseSync } from "../supabase/functions/_shared/syncClaim.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CODE_A = "SC-AAAAAAAA"; // CUSTOMER-A (usuario autenticado)
const CODE_B = "SC-BBBBBBBB"; // CUSTOMER-B (otra persona)

const profileA = {
  id: "cust-a",
  auth_user_id: "user-a",
  name: "Ana",
  email: "ana@example.com",
  phone: "+526641234567",
  customer_code: CODE_A,
  loyverse_customer_id: null,
  loyverse_sync_status: "pending",
};

// Transporte emulado de Loyverse: registra lo que realmente se enviaría.
function makeTransport(existing = []) {
  const customers = existing.map((c) => ({ ...c }));
  const sent = [];
  return {
    sent,
    customers,
    async listByEmail(email) {
      return customers.filter((c) => c.email === email);
    },
    async listByPhone(digits) {
      return customers.filter((c) => String(c.phone_number || "").replace(/\D/g, "").endsWith(digits.slice(-10)));
    },
    async create(payload) {
      sent.push({ op: "create", payload });
      if (payload.customer_code && customers.some((c) => c.customer_code === payload.customer_code)) {
        const e = new Error("customer_code already exists");
        e.status = 400;
        throw e;
      }
      const created = { id: `lv-${customers.length + 1}`, ...payload };
      customers.push(created);
      return created;
    },
    async update(id, payload) {
      sent.push({ op: "update", id, payload });
      Object.assign(customers.find((c) => c.id === id), payload);
      return { id };
    },
  };
}

const claimDb = () => ({
  async claim() {
    return { count: 1, error: null };
  },
  async release() {
    return { error: null };
  },
});

// Reproduce el orden de la Edge: validar el código → (si ok) sync.
async function edgeFlow({ body, profile, transport }) {
  const check = resolveTrustedCustomerCode({ requestedCode: body.customerCode, profile });
  if (!check.ok) return { status: check.status, code: check.code, outcome: null };
  const outcome = await runLoyverseSync({
    db: claimDb(),
    transport,
    authUserId: profile?.auth_user_id || "user-x",
    profile,
    name: profile?.name || "x",
    email: profile?.email || null,
    phone: profile?.phone || null,
    customerCode: check.customerCode,
  });
  return { status: 200, outcome };
}

// ---------------- Caso 1 — customerCode correcto ----------------
test("Caso 1: usuario con CUSTOMER-A que envía CUSTOMER-A → se usa CUSTOMER-A y el sync funciona", async () => {
  const transport = makeTransport();
  const r = await edgeFlow({ body: { operation: "link_or_create", customerCode: CODE_A }, profile: profileA, transport });
  assert.equal(r.status, 200);
  assert.equal(r.outcome.status, "done");
  assert.equal(r.outcome.result.status, "created");
  assert.equal(transport.sent[0].payload.customer_code, CODE_A);
});

test("Caso 1: el mismo código con espacios o minúsculas se acepta y se usa el valor canónico de la base", () => {
  for (const variant of [` ${CODE_A} `, CODE_A.toLowerCase()]) {
    assert.deepEqual(resolveTrustedCustomerCode({ requestedCode: variant, profile: profileA }), { ok: true, customerCode: CODE_A });
  }
});

// ---------------- Caso 2 — customerCode malicioso ----------------
test("Caso 2: usuario con CUSTOMER-A que envía CUSTOMER-B → 409 customer_code_mismatch y Loyverse NO se toca", async () => {
  const transport = makeTransport();
  const r = await edgeFlow({ body: { operation: "link_or_create", customerCode: CODE_B }, profile: profileA, transport });
  assert.equal(r.status, 409);
  assert.equal(r.code, "customer_code_mismatch");
  assert.equal(transport.sent.length, 0, "ninguna llamada a la API de Loyverse");
});

test("Caso 2: también se rechaza aunque el perfil ya esté vinculado (synced)", () => {
  const synced = { ...profileA, loyverse_customer_id: "lv-9", loyverse_sync_status: "synced" };
  const r = resolveTrustedCustomerCode({ requestedCode: CODE_B, profile: synced });
  assert.deepEqual(r, { ok: false, status: 409, code: "customer_code_mismatch" });
});

// ---------------- Caso 3 — inexistente / no autorizado ----------------
test("Caso 3: códigos que no pertenecen a la identidad (inexistente, basura, inyección) → 409", () => {
  for (const code of ["SC-ZZZZZZZZ", "CUSTOMER-B", "SC-AAAAAAA", "SC-AAAAAAAA-X", "' or 1=1 --", "x".repeat(500)]) {
    const r = resolveTrustedCustomerCode({ requestedCode: code, profile: profileA });
    assert.deepEqual(r, { ok: false, status: 409, code: "customer_code_mismatch" }, code);
  }
});

test("Caso 3: tipos no-string → 400 invalid_body", () => {
  for (const code of [123, true, { code: CODE_A }, [CODE_A]]) {
    assert.deepEqual(resolveTrustedCustomerCode({ requestedCode: code, profile: profileA }), {
      ok: false,
      status: 400,
      code: "invalid_body",
    });
  }
});

test("Caso 3: sin fila customers, el código del body NUNCA se usa (no_profile)", async () => {
  assert.deepEqual(resolveTrustedCustomerCode({ requestedCode: CODE_B, profile: null }), { ok: true, customerCode: null });
  const transport = makeTransport();
  const r = await edgeFlow({ body: { customerCode: CODE_B }, profile: null, transport });
  assert.equal(r.outcome.status, "no_profile");
  assert.equal(transport.sent.length, 0);
});

// ---------------- Caso 4 — compatibilidad ----------------
test("Caso 4: body sin customerCode (o null/vacío) → se usa el de la base", async () => {
  for (const requestedCode of [undefined, null, ""]) {
    assert.deepEqual(resolveTrustedCustomerCode({ requestedCode, profile: profileA }), { ok: true, customerCode: CODE_A });
  }
  const transport = makeTransport();
  const r = await edgeFlow({ body: { operation: "link_or_create" }, profile: profileA, transport });
  assert.equal(r.outcome.result.status, "created");
  assert.equal(transport.sent[0].payload.customer_code, CODE_A);
});

test("Caso 4: vincular a un cliente Loyverse existente por email sigue funcionando (relleno del código de la base)", async () => {
  const transport = makeTransport([{ id: "lv-1", name: "Ana", email: "ana@example.com", phone_number: null, customer_code: null }]);
  const r = await edgeFlow({ body: { operation: "link_or_create", customerCode: CODE_A }, profile: profileA, transport });
  assert.equal(r.outcome.status, "done");
  assert.equal(r.outcome.result.status, "updated");
  assert.equal(r.outcome.result.loyverseCustomerId, "lv-1");
  assert.equal(transport.sent.find((s) => s.op === "update").payload.customer_code, CODE_A);
});

test("Caso 4: perfil ya vinculado con su propio código → already_linked sin red", async () => {
  const transport = makeTransport();
  const synced = { ...profileA, loyverse_customer_id: "lv-9", loyverse_sync_status: "synced" };
  const r = await edgeFlow({ body: { customerCode: CODE_A }, profile: synced, transport });
  assert.equal(r.outcome.status, "already_linked");
  assert.equal(transport.sent.length, 0);
});

test("Caso 4: el frontend envía exactamente profile.customer_code (pasa la verificación)", () => {
  const src = readFileSync(join(REPO_ROOT, "src/services/loyverse/loyverseCustomerService.js"), "utf8");
  assert.match(src, /customerCode:\s*profile\.customer_code/);
});

// ---------------- Estático: la Edge ya no da prioridad al body ----------------
test("la Edge loyverse-customers valida el código antes del sync y no usa body.customerCode como valor", () => {
  const edge = readFileSync(join(REPO_ROOT, "supabase/functions/loyverse-customers/index.ts"), "utf8");
  assert.equal(/body\.customerCode\s*\|\|/.test(edge), false, "el body ya no tiene prioridad");
  assert.ok(edge.includes("resolveTrustedCustomerCode({ requestedCode: body.customerCode, profile })"));
  assert.ok(edge.indexOf("resolveTrustedCustomerCode(") < edge.indexOf("runLoyverseSync({"), "la verificación ocurre antes del sync");
  assert.ok(edge.includes("const customerCode = codeCheck.customerCode;"));
  assert.match(edge, /logSyncEvent\(admin,[\s\S]*?customer_code_mismatch/, "el rechazo se audita con service_role");
});
