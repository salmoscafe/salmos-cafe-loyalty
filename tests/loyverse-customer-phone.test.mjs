// ---------------------------------------------------------------
// loyverse-customer-phone.test.mjs — autoridad del teléfono en la Edge
// `loyverse-customers`.
//
// Antes: `const phone = body.phone || profile?.phone || user.phone || null`
// → el body podía sustituir a customers.phone en lo enviado a Loyverse.
// Ahora: resolveTrustedPhone() usa SIEMPRE profile.phone (customers.phone);
// body.phone solo puede confirmarlo (idéntico y E.164 MX). Cualquier otro
// valor → 409 phone_mismatch, sin llamar a Loyverse.
// ---------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveTrustedCustomerCode,
  resolveTrustedPhone,
  isCanonicalMxPhone,
  MX_E164_PHONE_PATTERN,
} from "../supabase/functions/_shared/loyverseCore.js";
import { runLoyverseSync } from "../supabase/functions/_shared/syncClaim.js";
import { createDatabase, runAs, POSTGRES } from "./helpers/supabaseSqlHarness.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PHONE = "+526641234567"; // customers.phone del usuario autenticado
const OTHER = "+526649876543"; // número de otra persona

const withPhone = {
  id: "cust-a",
  auth_user_id: "user-a",
  name: "Ana",
  email: "ana@example.com",
  phone: PHONE,
  customer_code: "SC-AAAAAAAA",
  loyverse_customer_id: null,
  loyverse_sync_status: "pending",
};
const withoutPhone = { ...withPhone, phone: null };

// Loyverse emulado: registra TODO lo que se consultaría o enviaría.
function makeTransport(existing = []) {
  const customers = existing.map((c) => ({ ...c }));
  const calls = [];
  return {
    calls,
    async listByEmail(email) {
      calls.push({ op: "listByEmail", email });
      return customers.filter((c) => c.email === email);
    },
    async listByPhone(digits) {
      calls.push({ op: "listByPhone", digits });
      return customers.filter((c) => String(c.phone_number || "").replace(/\D/g, "") === digits);
    },
    async create(payload) {
      calls.push({ op: "create", payload });
      const created = { id: `lv-${customers.length + 1}`, ...payload };
      customers.push(created);
      return created;
    },
    async update(id, payload) {
      calls.push({ op: "update", id, payload });
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

// Reproduce el orden de la Edge: customerCode → teléfono → (si ok) sync.
// `user` simula al usuario de GoTrue: su phone/metadata NUNCA deben usarse.
async function edgeFlow({ body, profile, transport, user = {} }) {
  const code = resolveTrustedCustomerCode({ requestedCode: body.customerCode, profile });
  if (!code.ok) return { status: code.status, code: code.code, outcome: null };
  const phoneCheck = resolveTrustedPhone({ requestedPhone: body.phone, profile });
  if (!phoneCheck.ok) return { status: phoneCheck.status, code: phoneCheck.code, outcome: null };
  const outcome = await runLoyverseSync({
    db: claimDb(),
    transport,
    authUserId: profile?.auth_user_id || "user-x",
    profile,
    name: profile?.name || user.user_metadata?.name || "x",
    email: user.email || profile?.email || null,
    phone: phoneCheck.phone,
    customerCode: code.customerCode,
  });
  return { status: 200, outcome };
}

// Todo teléfono que llegaría a Loyverse (consultas y escrituras).
function phonesSentToLoyverse(transport) {
  const out = [];
  for (const c of transport.calls) {
    if (c.op === "listByPhone") out.push(c.digits);
    if ((c.op === "create" || c.op === "update") && c.payload.phone_number != null) out.push(c.payload.phone_number);
  }
  return out;
}

const digits = (v) => String(v).replace(/\D/g, "");

// ============ Customer con teléfono (customers.phone = +526641234567) ============
test("1. body sin phone (ausente / null / \"\") → usa customers.phone", async () => {
  for (const requestedPhone of [undefined, null, ""]) {
    assert.deepEqual(resolveTrustedPhone({ requestedPhone, profile: withPhone }), { ok: true, phone: PHONE });
  }
  const transport = makeTransport();
  const r = await edgeFlow({ body: { operation: "link_or_create" }, profile: withPhone, transport });
  assert.equal(r.status, 200);
  assert.equal(r.outcome.result.status, "created");
  assert.equal(transport.calls.find((c) => c.op === "create").payload.phone_number, PHONE);
});

test("2. body.phone idéntico → continúa y se usa el valor de la base", async () => {
  assert.deepEqual(resolveTrustedPhone({ requestedPhone: PHONE, profile: withPhone }), { ok: true, phone: PHONE });
  const transport = makeTransport();
  const r = await edgeFlow({ body: { phone: PHONE }, profile: withPhone, transport });
  assert.equal(r.status, 200);
  assert.deepEqual(phonesSentToLoyverse(transport).map(digits), [digits(PHONE), digits(PHONE)]);
});

test("3. body.phone diferente → 409 phone_mismatch y Loyverse NO se toca", async () => {
  assert.deepEqual(resolveTrustedPhone({ requestedPhone: OTHER, profile: withPhone }), {
    ok: false,
    status: 409,
    code: "phone_mismatch",
  });
  const transport = makeTransport();
  const r = await edgeFlow({ body: { phone: OTHER }, profile: withPhone, transport });
  assert.equal(r.status, 409);
  assert.equal(r.code, "phone_mismatch");
  assert.equal(transport.calls.length, 0, "ninguna llamada a la API de Loyverse");
});

test("4. body.phone extranjero → 409 phone_mismatch", () => {
  for (const v of ["+16195551234", "+442079460958", "+5216641234567", "16641234567"]) {
    assert.equal(resolveTrustedPhone({ requestedPhone: v, profile: withPhone }).code, "phone_mismatch", v);
  }
});

test("5. el MISMO número con espacios, guiones u otro formato NO se normaliza → 409", () => {
  for (const v of ["+52 664 123 4567", "+52-664-123-4567", "664 123 4567", "6641234567", "526641234567", "(664) 123-4567", ` ${PHONE}`, `${PHONE} `, `${PHONE}\n`]) {
    assert.equal(resolveTrustedPhone({ requestedPhone: v, profile: withPhone }).code, "phone_mismatch", JSON.stringify(v));
  }
});

test("6. caracteres Unicode engañosos → 409", () => {
  for (const v of ["+52６６４１２３４５６７", "+52٦٦٤١٢٣٤٥٦٧", "+52664123​4567", "＋526641234567", `${PHONE}\u0000`]) {
    assert.equal(resolveTrustedPhone({ requestedPhone: v, profile: withPhone }).code, "phone_mismatch", JSON.stringify(v));
  }
});

test("7. body.phone no-string → 400 invalid_body (antes que cualquier otra cosa)", () => {
  for (const v of [6641234567, true, { phone: PHONE }, [PHONE], 0]) {
    assert.deepEqual(resolveTrustedPhone({ requestedPhone: v, profile: withPhone }), {
      ok: false,
      status: 400,
      code: "invalid_body",
    });
  }
  assert.equal(resolveTrustedPhone({ requestedPhone: 123, profile: null }).code, "invalid_body");
});

// ============ Customer sin teléfono (customers.phone = NULL) ============
test("8. sin teléfono en la base y body sin phone → sync sin teléfono (comportamiento existente)", async () => {
  for (const requestedPhone of [undefined, null, ""]) {
    assert.deepEqual(resolveTrustedPhone({ requestedPhone, profile: withoutPhone }), { ok: true, phone: null });
  }
  const transport = makeTransport();
  const r = await edgeFlow({ body: { phone: null }, profile: withoutPhone, transport });
  assert.equal(r.status, 200);
  assert.equal(r.outcome.result.status, "created");
  assert.equal(transport.calls.some((c) => c.op === "listByPhone"), false, "sin búsqueda por teléfono");
  assert.equal(transport.calls.find((c) => c.op === "create").payload.phone_number ?? null, null);
});

test("9. sin teléfono en la base y body con phone → 409 phone_mismatch y NO llama a Loyverse", async () => {
  const transport = makeTransport();
  const r = await edgeFlow({ body: { phone: PHONE }, profile: withoutPhone, transport });
  assert.equal(r.status, 409);
  assert.equal(r.code, "phone_mismatch");
  assert.equal(transport.calls.length, 0);
});

test("sin fila customers: el teléfono del body NUNCA se usa (no_profile, sin Loyverse)", async () => {
  assert.deepEqual(resolveTrustedPhone({ requestedPhone: OTHER, profile: null }), { ok: true, phone: null });
  const transport = makeTransport();
  const r = await edgeFlow({ body: { phone: OTHER }, profile: null, transport });
  assert.equal(r.outcome.status, "no_profile");
  assert.equal(transport.calls.length, 0);
});

// ============ Seguridad ============
test("10. en ningún caso llega a Loyverse un teléfono distinto de customers.phone", async () => {
  const bodies = [{}, { phone: PHONE }, { phone: OTHER }, { phone: "" }, { phone: null }, { phone: "+52 664 123 4567" }, { phone: "6649876543" }];
  for (const profile of [withPhone, withoutPhone]) {
    for (const body of bodies) {
      const transport = makeTransport([{ id: "lv-1", name: "Otra", email: "otra@example.com", phone_number: OTHER, customer_code: null }]);
      await edgeFlow({ body, profile, transport });
      for (const sent of phonesSentToLoyverse(transport)) {
        assert.equal(digits(sent), digits(profile.phone), `body=${JSON.stringify(body)}`);
      }
    }
  }
});

test("11. mismatch → Loyverse no es llamado, también con perfil ya vinculado", async () => {
  const synced = { ...withPhone, loyverse_customer_id: "lv-9", loyverse_sync_status: "synced" };
  for (const profile of [withPhone, withoutPhone, synced]) {
    const transport = makeTransport();
    const r = await edgeFlow({ body: { phone: OTHER }, profile, transport });
    assert.equal(r.code, "phone_mismatch");
    assert.equal(transport.calls.length, 0);
  }
});

test("12. no se modifica customers.phone (ni el perfil en memoria ni la Edge escriben phone)", async () => {
  const profile = structuredClone(withPhone);
  for (const body of [{ phone: OTHER }, { phone: PHONE }, {}]) {
    resolveTrustedPhone({ requestedPhone: body.phone, profile });
    await edgeFlow({ body, profile, transport: makeTransport() });
  }
  assert.deepEqual(profile, withPhone);
  const edge = readFileSync(join(REPO_ROOT, "supabase/functions/loyverse-customers/index.ts"), "utf8");
  const updates = edge.match(/\.update\(\{[\s\S]*?\}\)/g) || [];
  assert.ok(updates.length > 0);
  for (const u of updates) assert.equal(/phone/.test(u), false, `update sin phone: ${u}`);
});

test("13. user.phone y la metadata de Auth nunca son fallback", async () => {
  const user = { phone: OTHER, email: "ana@example.com", user_metadata: { phone: OTHER, name: "Ana" } };
  for (const profile of [withPhone, withoutPhone]) {
    const transport = makeTransport();
    await edgeFlow({ body: {}, profile, transport, user });
    for (const sent of phonesSentToLoyverse(transport)) assert.equal(digits(sent), digits(PHONE));
    if (!profile.phone) assert.equal(phonesSentToLoyverse(transport).length, 0);
  }
  // Se revisa el CÓDIGO, sin comentarios (que sí mencionan user.phone).
  const edge = readFileSync(join(REPO_ROOT, "supabase/functions/loyverse-customers/index.ts"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/user\.phone/.test(edge), false, "sin user.phone");
  assert.equal(/user_metadata\??\.phone/.test(edge), false, "sin metadata.phone");
  assert.equal(/body\.phone\s*\|\|/.test(edge), false, "el body ya no tiene prioridad");
});

// ============ Estático: orden y forma en la Edge ============
test("la Edge resuelve el teléfono con resolveTrustedPhone antes del sync y responde 409 sin teléfonos", () => {
  const edge = readFileSync(join(REPO_ROOT, "supabase/functions/loyverse-customers/index.ts"), "utf8");
  assert.ok(edge.includes("resolveTrustedPhone({ requestedPhone: body.phone, profile })"));
  assert.ok(edge.indexOf("resolveTrustedPhone(") < edge.indexOf("runLoyverseSync({"), "la verificación ocurre antes del sync");
  assert.ok(edge.includes("const phone = phoneCheck.phone;"));
  assert.ok(edge.includes("json({ ok: false, code: phoneCheck.code, traceId, retriable: false }, phoneCheck.status)"));
});

test("el frontend envía exactamente profile.phone (compatible con la verificación)", () => {
  const src = readFileSync(join(REPO_ROOT, "src/services/loyverse/loyverseCustomerService.js"), "utf8");
  assert.match(src, /phone:\s*profile\.phone\s*\|\|\s*null/);
});

// ============ Paridad con 0025 ============
test("paridad: isCanonicalMxPhone ≡ CHECK customers_phone_e164_mx_check (0025) en Postgres real", async () => {
  assert.equal(MX_E164_PHONE_PATTERN.source, "^\\+52[0-9]{10}$");
  const db = await createDatabase();
  const uid = "aaaaaaaa-0000-4000-8000-000000000001";
  await db.query(`insert into auth.users (id, email) values ($1, 'p@example.com')`, [uid]);
  const corpus = [
    PHONE, "+521234567890", "+520000000000", "+52123456789", "+5212345678901", "+16195551234", "6641234567",
    "526641234567", "+52 6641234567", "+52-664-123-4567", "", " " + PHONE, PHONE + " ", PHONE + "\n",
    "+52６６４１２３４５６７", "+52٦٦٤١٢٣٤٥٦٧", "+52664123​4567", "＋526641234567", "+52664123456a", "52+6641234567",
  ];
  for (const v of corpus) {
    const r = await runAs(db, POSTGRES,
      `insert into public.customers (auth_user_id, name, phone, customer_code) values ($1, 'n', $2, 'SC-PPPPPPPP')`, [uid, v]);
    assert.equal(r.ok, isCanonicalMxPhone(v), `${JSON.stringify(v)} → SQL ${r.ok ? "acepta" : r.code}`);
    if (!r.ok) assert.equal(r.code, "23514", JSON.stringify(v));
  }
  assert.equal(isCanonicalMxPhone(null), false);
  assert.equal(isCanonicalMxPhone(undefined), false);
  assert.equal(isCanonicalMxPhone(5216641234567), false);
});
