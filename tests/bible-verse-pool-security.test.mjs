// ---------------------------------------------------------------
// bible-verse-pool-security.test.mjs — 0019: bible_verse_pool interna.
// Postgres real (PGlite) con todas las migraciones + default privileges
// de Supabase emulados. Antes de 0019, anon/authenticated podían leer,
// insertar, actualizar y BORRAR el pool vía /rest/v1.
// ---------------------------------------------------------------
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase, runAs, commitAs, asUser, ANON, SERVICE, POSTGRES, MIGRATIONS_DIR } from "./helpers/supabaseSqlHarness.mjs";

const UID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const CUST_A = "aaaaaaaa-1111-4000-8000-000000000001";
const WRITES = [
  "insert into public.bible_verse_pool (verse_id) values (999) returning verse_id",
  "update public.bible_verse_pool set verse_id = verse_id + 1000 returning verse_id",
  "delete from public.bible_verse_pool returning verse_id",
];

let db;
before(async () => {
  db = await createDatabase();
  await commitAs(db, POSTGRES, `insert into auth.users (id, email) values ('${UID_A}', 'a@test.local')`);
  await commitAs(
    db,
    POSTGRES,
    `insert into public.customers (id, auth_user_id, name, customer_code) values ('${CUST_A}', '${UID_A}', 'A', 'SC-AAAAAAAA')`
  );
});

test("estado: RLS activa, sin policies y sin privilegios para anon/authenticated", async () => {
  const [row] = await commitAs(
    db,
    POSTGRES,
    `select c.relrowsecurity as rls,
            (select count(*)::int from pg_policy where polrelid = c.oid) as policies,
            has_table_privilege('anon', c.oid, 'select,insert,update,delete') as anon_any,
            has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') as auth_any,
            has_table_privilege('service_role', c.oid, 'select') as svc_select,
            has_table_privilege('service_role', c.oid, 'insert,update,delete') as svc_write,
            (select count(*)::int from public.bible_verse_pool) as n
       from pg_class c where c.oid = 'public.bible_verse_pool'::regclass`
  );
  assert.equal(row.rls, true);
  assert.equal(row.policies, 0);
  assert.equal(row.anon_any, false);
  assert.equal(row.auth_any, false);
  assert.equal(row.svc_select, true);
  assert.equal(row.svc_write, false);
  assert.equal(row.n, 49, "los 49 ids del pool se conservan");
});

test("Caso A: lectura legítima — register_visit_with_receipt asigna un verse_id del pool", async () => {
  // Mismo camino que la Edge de sync: service_role → RPC SECURITY DEFINER.
  await db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    await tx.exec("set local role service_role");
    const r = await tx.query(
      `select public.register_visit_with_receipt($1::uuid, 'LV-VERSE-1', 80, null, null, null,
                                                  'loyverse', 'loyverse-receipts-sync', 'system') ->> 'visit_id' as visit_id`,
      [CUST_A]
    );
    const v = await tx.query(
      `select v.verse_id,
              exists (select 1 from public.bible_verse_pool p where p.verse_id = v.verse_id) as in_pool
         from public.loyalty_visits v where v.id = $1::uuid`,
      [r.rows[0].visit_id]
    );
    assert.notEqual(v.rows[0].verse_id, null, "la visita recibe un versículo");
    assert.equal(v.rows[0].in_pool, true, "el versículo sale del pool");
    await tx.rollback();
  });
});

test("Caso B: anon no puede leer ni modificar el pool", async () => {
  const read = await runAs(db, ANON, "select count(*) from public.bible_verse_pool");
  assert.equal(read.ok, false);
  for (const sql of WRITES) {
    const res = await runAs(db, ANON, sql);
    assert.equal(res.ok, false, `anon: ${sql}`);
    assert.match(res.error, /permission denied/);
  }
});

test("Caso C: authenticated no puede leer ni modificar el pool", async () => {
  const who = asUser(UID_A);
  const read = await runAs(db, who, "select count(*) from public.bible_verse_pool");
  assert.equal(read.ok, false);
  for (const sql of WRITES) {
    const res = await runAs(db, who, sql);
    assert.equal(res.ok, false, `authenticated: ${sql}`);
    assert.match(res.error, /permission denied/);
  }
});

test("Caso D: service_role lee el pool (diagnóstico); las escrituras quedan para migraciones", async () => {
  const read = await runAs(db, SERVICE, "select count(*)::int as n from public.bible_verse_pool");
  assert.equal(read.ok, true, read.error);
  assert.equal(read.rows[0].n, 49);
  for (const sql of WRITES) {
    const res = await runAs(db, SERVICE, sql);
    assert.equal(res.ok, false, `service_role no escribe el pool: ${sql}`);
  }
  // El rol de migraciones (postgres) sí mantiene el pool.
  const maint = await runAs(db, POSTGRES, "insert into public.bible_verse_pool (verse_id) values (998) returning verse_id");
  assert.equal(maint.ok, true, maint.error);
});

test("0019 es idempotente (re-aplicarla no falla ni cambia el estado)", async () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, "0019_bible_verse_pool_lockdown.sql"), "utf8");
  await db.transaction(async (tx) => {
    await tx.exec(sql);
    const r = await tx.query(
      `select has_table_privilege('anon', 'public.bible_verse_pool', 'select') as anon,
              (select count(*)::int from public.bible_verse_pool) as n`
    );
    assert.equal(r.rows[0].anon, false);
    assert.equal(r.rows[0].n, 49);
    await tx.rollback();
  });
});
