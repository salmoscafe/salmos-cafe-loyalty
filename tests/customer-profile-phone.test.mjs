// ---------------------------------------------------------------
// customer-profile-phone.test.mjs — contrato del frontend tras 0027:
// ensureCustomerProfile DELEGA en la RPC public.ensure_own_customer()
// (el cliente ya no genera customer_code ni escribe customers). Aquí se
// verifica que:
//   * el único canal es supabaseClient.rpc('ensure_own_customer');
//   * la respuesta se entrega tal cual + phoneConflict derivado de
//     _conflict_phone Y/O (initialProfilePhone && !row.phone);
//   * acepta PostgREST como objeto único o array de un elemento;
//   * un error de la RPC se propaga.
// La semántica SQL (canonicalización, idempotencia, conflictos) se valida
// en ensure-own-customer.test.mjs contra Postgres real.
// ---------------------------------------------------------------
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const db = { responses: [], fromCalls: 0 };

function rpcRow(user, overrides = {}) {
  return {
    id: `r-${user.id}`,
    auth_user_id: user.id,
    name: user.user_metadata?.name || (user.email ? user.email.split("@")[0] : "") || "Cliente Salmos",
    email: user.email,
    email_verified: false,
    phone: null,
    customer_code: "SC-AAAAAAAA",
    loyverse_customer_id: null,
    loyverse_sync_status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
    _conflict_phone: false,
    ...overrides,
  };
}

async function rpc(name, args) {
  assert.equal(name, "ensure_own_customer");
  const next = db.responses.shift();
  if (!next) throw new Error("rpc() llamado sin respuesta programada");
  return typeof next === "function" ? next(args) : next;
}

function fromThrows(table) {
  db.fromCalls++;
  throw new Error(`el frontend ya NO lee/escribe customers directamente (from("${table}"))`);
}

mock.module("../src/lib/supabase/client.js", {
  namedExports: { isSupabaseConfigured: true, supabaseClient: { rpc, from: fromThrows, auth: {} } },
});

const { ensureCustomerProfile, initialProfilePhone } = await import("../src/services/auth/supabaseAuthService.js");

beforeEach(() => {
  db.responses.length = 0;
  db.fromCalls = 0;
});

const emailUser = (id, metaPhone, extra = {}) => ({
  id,
  email: `${id}@test.local`,
  phone: "",
  user_metadata: { name: `Cliente ${id}`, ...(metaPhone !== undefined ? { phone: metaPhone } : {}), ...extra },
});

test("1. único canal: rpc('ensure_own_customer'), sin from/insert/update sobre customers", async () => {
  const u = emailUser("u1", "+526645550000");
  db.responses.push({ data: rpcRow(u, { email_verified: true }) });
  const row = await ensureCustomerProfile(u);
  assert.equal(row.auth_user_id, "u1");
  assert.equal(row.customer_code, "SC-AAAAAAAA");
  assert.equal(row.email_verified, true, "passthrough de la RPC");
  assert.equal(db.fromCalls, 0, "no usa el acceso directo por tabla");
});

test("2. sin conflicto: phoneConflict false aunque la metadata tenga teléfono", async () => {
  const u = emailUser("u2", "+526645550001");
  db.responses.push({ data: rpcRow(u, { phone: "+526645550001" }) });
  const row = await ensureCustomerProfile(u);
  assert.equal(row.phone, "+526645550001");
  assert.equal(row.phoneConflict, false);
});

test("3. _conflict_phone de la RPC (sesión de creación) → phoneConflict true", async () => {
  const u = emailUser("u3", "52 664 555 0002");
  db.responses.push({ data: rpcRow(u, { phone: null, _conflict_phone: true }) });
  const row = await ensureCustomerProfile(u);
  assert.equal(row.phone, null);
  assert.equal(row.phoneConflict, true);
});

test("4. sesión posterior: fila sin teléfono + metadata con teléfono → flag derivado", async () => {
  const u = emailUser("u4", "+526645550003");
  db.responses.push({ data: rpcRow(u, { phone: null, _conflict_phone: false }) });
  const row = await ensureCustomerProfile(u);
  assert.equal(row.phoneConflict, true, "la UI mantiene la advertencia");
});

test("5. metadata inválida + fila sin teléfono → sin flag (no hay conflicto real)", async () => {
  const u = emailUser("u5", "12345");
  db.responses.push({ data: rpcRow(u, { phone: null }) });
  const row = await ensureCustomerProfile(u);
  assert.equal(row.phone, null);
  assert.equal(row.phoneConflict, false);
});

test("6. fila con teléfono + metadata → sin flag", async () => {
  const u = emailUser("u6", "+526645550004");
  db.responses.push({ data: rpcRow(u, { phone: "+526645550004" }) });
  const row = await ensureCustomerProfile(u);
  assert.equal(row.phoneConflict, false);
});

test("7. PostgREST en array de 1 elemento (SETOF) también se acepta", async () => {
  const u = emailUser("u7");
  db.responses.push({ data: [rpcRow(u)] });
  const row = await ensureCustomerProfile(u);
  assert.equal(row.id, `r-${u.id}`);
  assert.equal(row.phoneConflict, false);
});

test("8. el error de la RPC se propaga (p. ej. EMAIL_ALREADY_REGISTERED)", async () => {
  const u = emailUser("u8");
  const err = new Error("EMAIL_ALREADY_REGISTERED");
  err.code = "P0001";
  db.responses.push({ data: null, error: err });
  await assert.rejects(() => ensureCustomerProfile(u), /EMAIL_ALREADY_REGISTERED/);
});

test("initialProfilePhone (regla del frontend, ya no se persiste aquí)", () => {
  assert.equal(initialProfilePhone({ phone: "526645550011", user_metadata: {} }), null);
  assert.equal(initialProfilePhone({ user_metadata: { phone: "+526645550011" } }, null), "+526645550011");
  assert.equal(initialProfilePhone({ user_metadata: { phone: "+526645550011" } }, "6645550012"), "+526645550012", "el parámetro explícito tiene prioridad");
});