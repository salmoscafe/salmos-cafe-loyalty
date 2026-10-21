// ---------------------------------------------------------------
// 0028-revoke-customer-client-writes.test.mjs — sobre TODAS las
// migraciones (ya con 0028). Verifica la matriz EFECTIVA de
// privilegios (has_table_privilege / has_column_privilege):
//   * anon            → customers: SOLO SELECT.
//   * authenticated   → customers: SOLO SELECT (sin INSERT ni UPDATE,
//                       ni por columna, heredadas de 0008/0023).
//   * service_role    → intacto (las Edge Functions siguen escribiendo).
//   * el REGISTRO completo (crear la fila) sigue funcionando vía la
//     RPC public.ensure_own_customer() (0027, execute authenticated).
// ---------------------------------------------------------------
import assert from "node:assert/strict";
import { test, before } from "node:test";
import {
  createDatabase,
  runAs,
  commitAs,
  POSTGRES,
  ANON,
  SERVICE,
  asUser,
} from "./helpers/supabaseSqlHarness.mjs";

const UID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const UID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const CUST_A = "aaaaaaaa-1111-4000-8000-000000000001";

const INSERT_COLS = ["auth_user_id", "name", "email", "phone", "customer_code", "profile"];
const UPDATE_COLS = ["name", "email", "profile"];

let db;
before(async () => {
  db = await createDatabase();
  await commitAs(db, POSTGRES, `insert into auth.users (id, email) values ('${UID_A}', 'a@test.local'), ('${UID_B}', 'b@test.local'), ('eeeeeeee-0000-4000-8000-00000000000e', 'svc@test.local')`);
  await commitAs(
    db,
    POSTGRES,
    `insert into public.customers (id, auth_user_id, name, email, phone, customer_code) values
       ('${CUST_A}', '${UID_A}', 'A', 'a@test.local', '+526640000001', 'SC-AAAAAAAA'),
       ('bbbbbbbb-1111-4000-8000-000000000002', '${UID_B}', 'B', 'b@test.local', '+526640000002', 'SC-BBBBBBBB')`
  );
});

test("0028 matriz tabla: anon y authenticated SOLO SELECT; service_role completo", async () => {
  const [r] = await commitAs(
    db,
    POSTGRES,
    `select
       has_table_privilege('anon', 'public.customers', 'select') as anon_select,
       has_table_privilege('anon', 'public.customers', 'insert') as anon_insert,
       has_table_privilege('anon', 'public.customers', 'update') as anon_update,
       has_table_privilege('anon', 'public.customers', 'delete') as anon_delete,
       has_table_privilege('authenticated', 'public.customers', 'select') as auth_select,
       has_table_privilege('authenticated', 'public.customers', 'insert') as auth_insert,
       has_table_privilege('authenticated', 'public.customers', 'update') as auth_update,
       has_table_privilege('authenticated', 'public.customers', 'delete') as auth_delete,
       has_table_privilege('service_role', 'public.customers', 'select') as svc_select,
       has_table_privilege('service_role', 'public.customers', 'insert') as svc_insert,
       has_table_privilege('service_role', 'public.customers', 'update') as svc_update,
       has_table_privilege('service_role', 'public.customers', 'delete') as svc_delete`
  );
  assert.deepEqual({ s: r.anon_select, i: r.anon_insert, u: r.anon_update, d: r.anon_delete }, { s: true, i: false, u: false, d: false }, "anon SOLO SELECT");
  assert.deepEqual({ s: r.auth_select, i: r.auth_insert, u: r.auth_update, d: r.auth_delete }, { s: true, i: false, u: false, d: false }, "authenticated SOLO SELECT");
  assert.deepEqual({ s: r.svc_select, i: r.svc_insert, u: r.svc_update, d: r.svc_delete }, { s: true, i: true, u: true, d: true }, "service_role completo");
});

test("0028 por columna: authenticated NO tiene INSERT/UPDATE en NINGUNA columna", async () => {
  const [r] = await commitAs(
    db,
    POSTGRES,
    `select
       ${INSERT_COLS.map((c) => `has_column_privilege('authenticated', 'public.customers', '${c}', 'insert') as ins_${c}`).join(",")},
       ${UPDATE_COLS.map((c) => `has_column_privilege('authenticated', 'public.customers', '${c}', 'update') as upd_${c}`).join(",")}`
  );
  for (const c of INSERT_COLS) assert.equal(r[`ins_${c}`], false, `INSERT ${c}`);
  for (const c of UPDATE_COLS) assert.equal(r[`upd_${c}`], false, `UPDATE ${c}`);
});

test("0028 RPC: EXECUTE de ensure_own_customer solo para authenticated (sin cambios)", async () => {
  const [r] = await commitAs(
    db,
    POSTGRES,
    `select has_function_privilege('anon', 'public.ensure_own_customer()', 'execute') as anon,
            has_function_privilege('authenticated', 'public.ensure_own_customer()', 'execute') as authd,
            has_function_privilege('service_role', 'public.ensure_own_customer()', 'execute') as svc`
  );
  assert.equal(r.anon, false);
  assert.equal(r.authd, true);
  assert.equal(r.svc, false);
});

test("0028 comportamiento: anon/authenticated no escriben; SELECT propio sí (RLS)", async () => {
  const forbidden = [
    "insert into public.customers (auth_user_id, name, customer_code) values ('aaaaaaaa-0000-4000-8000-999999999999', 'X', 'SC-99999999')",
    "update public.customers set name = 'hack' returning id",
    "delete from public.customers returning id",
  ];
  for (const who of [ANON, asUser(UID_A)]) {
    for (const sql of forbidden) {
      const r = await runAs(db, who, sql);
      assert.equal(r.ok, false, `${who.role}: ${sql}`);
      assert.equal(r.code, "42501", `${who.role}: ${sql}`);
    }
  }

  // SELECT por RLS: propio sí, ajeno no.
  const own = await runAs(db, asUser(UID_A), "select id from public.customers where auth_user_id = $1", [UID_A]);
  assert.deepEqual(own.rows.map((x) => x.id), [CUST_A], "ve su propia fila");
  const other = await runAs(db, asUser(UID_A), "select id from public.customers where auth_user_id = $1", [UID_B]);
  assert.equal(other.rows.length, 0, "no ve la fila ajena (RLS)");
});

test("0028 service_role sigue escribiendo (Edge Functions intactas)", async () => {
  const r = await runAs(db, SERVICE, "update public.customers set phone = '+526640000099' where auth_user_id = $1 returning phone", [UID_A]);
  assert.equal(r.ok, true, r.error);
  const ins = await runAs(db, SERVICE, "insert into public.customers (auth_user_id, name, customer_code) values ('eeeeeeee-0000-4000-8000-00000000000e', 'S', 'SC-EEEEEEEE') returning id");
  assert.equal(ins.ok, true, ins.error);
  const del = await runAs(db, SERVICE, "delete from public.customers where customer_code = 'SC-EEEEEEEE' returning id");
  assert.equal(del.ok, true, del.error);
});

test("0028 registro completo vía RPC sigue funcionando (ventana cerrada, camino nuevo)", async () => {
  const rdb = await createDatabase({ upTo: "0028" });
  const u = "cccccccc-0000-4000-8000-00000000000c";
  await commitAs(rdb, POSTGRES, `insert into auth.users (id, email, raw_user_meta_data) values ($1, 'nuevo@test.local', '{"name":"Nuevo","phone":"52 664 555 0013"}')`, [u]);
  const [row] = await commitAs(rdb, { role: "authenticated", uid: u }, "select * from public.ensure_own_customer()");
  assert.equal(row.auth_user_id, u);
  assert.equal(row.name, "Nuevo");
  assert.equal(row.phone, "+526645550013", "la RPC canonicaliza y persiste");
  assert.match(row.customer_code, /^SC-[0-9A-HJ-NP-Z]{8}$/);
  const [again] = await commitAs(rdb, { role: "authenticated", uid: u }, "select * from public.ensure_own_customer()");
  assert.equal(again.id, row.id, "idempotente");
  const [cnt] = await commitAs(rdb, POSTGRES, "select count(*)::int as n from public.customers");
  assert.equal(cnt.n, 1);
});