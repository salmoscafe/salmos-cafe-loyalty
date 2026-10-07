// ---------------------------------------------------------------
// customer-profile-phone.test.mjs — ensureCustomerProfile (modo real)
// con un doble de supabase-js en memoria que respeta la unicidad de
// customers_phone_unique_key y de auth_user_id.
//   * el teléfono del registro (user_metadata.phone) se persiste en
//     customers.phone en E.164 MX al CREAR la fila;
//   * sin teléfono → null (Google/OAuth no se rompe);
//   * conflicto de unicidad → fila sin teléfono + phoneConflict, sin
//     tocar al otro cliente;
//   * con la fila ya creada, la metadata se ignora.
// ---------------------------------------------------------------
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const db = { customers: [], ops: [] };

function digits(v) {
  return String(v || "").replace(/\D/g, "");
}

function fakeFrom(table) {
  assert.equal(table, "customers");
  const filters = [];
  const api = {
    select() {
      return api;
    },
    eq(col, val) {
      filters.push([col, val]);
      return api;
    },
    async maybeSingle() {
      const row = db.customers.find((r) => filters.every(([c, v]) => r[c] === v));
      return { data: row ? { ...row } : null, error: null };
    },
    insert(row) {
      db.ops.push({ op: "insert", row: { ...row } });
      return {
        select() {
          return {
            async single() {
              if (db.customers.some((r) => r.auth_user_id === row.auth_user_id)) {
                return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "customers_auth_user_id_key"' } };
              }
              if (row.phone && db.customers.some((r) => r.phone && digits(r.phone) === digits(row.phone))) {
                return {
                  data: null,
                  error: { code: "23505", message: 'duplicate key value violates unique constraint "customers_phone_unique_key"' },
                };
              }
              const created = { id: `c-${db.customers.length + 1}`, loyverse_sync_status: "pending", ...row };
              db.customers.push(created);
              return { data: { ...created }, error: null };
            },
          };
        },
      };
    },
    update(values) {
      db.ops.push({ op: "update", values });
      throw new Error("ensureCustomerProfile nunca debe hacer UPDATE");
    },
  };
  return api;
}

mock.module("../src/lib/supabase/client.js", {
  namedExports: { isSupabaseConfigured: true, supabaseClient: { from: fakeFrom, auth: {} } },
});

const { ensureCustomerProfile, initialProfilePhone } = await import("../src/services/auth/supabaseAuthService.js");

beforeEach(() => {
  db.customers.length = 0;
  db.ops.length = 0;
});

const emailUser = (id, metaPhone, extra = {}) => ({
  id,
  email: `${id}@test.local`,
  phone: "",
  user_metadata: { name: `Cliente ${id}`, ...(metaPhone !== undefined ? { phone: metaPhone } : {}), ...extra },
});

test("1. registro con teléfono → customers.phone canónico E.164 MX", async () => {
  for (const [id, meta] of [["u1", "+526645550000"], ["u2", "+52 6645550001"], ["u3", "6645550002"]]) {
    const row = await ensureCustomerProfile(emailUser(id, meta), {});
    assert.match(row.phone, /^\+52\d{10}$/);
    assert.equal(row.phone, `+52${digits(meta).slice(-10)}`);
    assert.equal(row.phoneConflict, undefined);
  }
});

test("2. registro sin teléfono → customers.phone NULL", async () => {
  const row = await ensureCustomerProfile(emailUser("u4"), {});
  assert.equal(row.phone, null);
});

test("2b. metadata inválida o no-string → NULL (nunca texto crudo)", async () => {
  assert.equal((await ensureCustomerProfile(emailUser("u5", "12345"), {})).phone, null);
  assert.equal((await ensureCustomerProfile(emailUser("u6", 6645550003), {})).phone, null);
  assert.equal((await ensureCustomerProfile(emailUser("u7", ""), {})).phone, null);
});

test("3. conflicto de teléfono → fila sin teléfono, phoneConflict y el otro cliente intacto", async () => {
  const holder = await ensureCustomerProfile(emailUser("holder", "+526645550099"), {});
  const snapshot = JSON.stringify(db.customers[0]);
  const row = await ensureCustomerProfile(emailUser("late", "664 555 0099"), {});
  assert.equal(row.phone, null);
  assert.equal(row.phoneConflict, true, "el conflicto no se oculta");
  assert.equal(row.auth_user_id, "late");
  assert.equal(JSON.stringify(db.customers[0]), snapshot, "no se modifica al otro cliente");
  assert.equal(holder.phone, "+526645550099");
  assert.equal(db.ops.filter((o) => o.op === "update").length, 0);
  assert.deepEqual(db.ops.filter((o) => o.op === "insert").map((o) => o.row.phone), ["+526645550099", "+526645550099", null]);
});

test("4. Google/OAuth sin teléfono → se crea el perfil con phone NULL y nombre de Google", async () => {
  const googleUser = {
    id: "g1",
    email: "g1@gmail.com",
    phone: "",
    user_metadata: { full_name: "Ana Google", avatar_url: "x", email_verified: true, phone_verified: false },
  };
  const row = await ensureCustomerProfile(googleUser, {});
  assert.equal(row.phone, null);
  assert.equal(row.name, "Ana Google");
});

test("5. con la fila ya creada, la metadata se ignora (no es fuente permanente)", async () => {
  await ensureCustomerProfile(emailUser("u8", "+526645550010"), {});
  const again = await ensureCustomerProfile(emailUser("u8", "+526645559999"), {});
  assert.equal(again.phone, "+526645550010");
  assert.equal(db.ops.filter((o) => o.op === "insert").length, 1);
});

test("6. auth.users.phone (GoTrue) ya no es fuente del teléfono", () => {
  assert.equal(initialProfilePhone({ phone: "526645550011", user_metadata: {} }), null);
  assert.equal(initialProfilePhone({ user_metadata: { phone: "+526645550011" } }, null), "+526645550011");
  assert.equal(initialProfilePhone({ user_metadata: { phone: "+526645550011" } }, "6645550012"), "+526645550012", "el parámetro explícito tiene prioridad");
});

test("7. carrera por auth_user_id (doble llamada) → relee y devuelve la fila existente", async () => {
  const u = emailUser("u9", "+526645550013");
  const [a, b] = await Promise.all([ensureCustomerProfile(u, {}), ensureCustomerProfile(u, {})]);
  assert.equal(a.id, b.id);
  assert.equal(db.customers.filter((r) => r.auth_user_id === "u9").length, 1);
});
