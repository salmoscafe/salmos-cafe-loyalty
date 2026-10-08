// ---------------------------------------------------------------
// customer-sync-events-permissions.test.mjs — 0026: customer_sync_events
// solo la escribe el backend (service_role).
// Postgres real (PGlite) con las migraciones + default privileges de
// Supabase emulados. Antes de 0026 el dueño podía insertar, modificar y
// borrar sus propios eventos (policy sync_events_own_all FOR ALL) y
// anon/authenticated tenían todos los privilegios de tabla.
// La 0026 se aplica SOBRE una base 0025 con datos, igual que en remoto.
// ---------------------------------------------------------------
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase, runAs, commitAs, asUser, ANON, SERVICE, POSTGRES, MIGRATIONS_DIR } from "./helpers/supabaseSqlHarness.mjs";

const MIGRATION_0026 = readFileSync(join(MIGRATIONS_DIR, "0026_customer_sync_events_backend_only.sql"), "utf8");

const T = "public.customer_sync_events";
const UID_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const UID_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const EV_A1 = "aaaaaaaa-5555-4000-8000-0000000000a1";
const EV_A2 = "aaaaaaaa-5555-4000-8000-0000000000a2";
const EV_B1 = "bbbbbbbb-5555-4000-8000-0000000000b1";
const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const ROLES = ["anon", "authenticated", "service_role", "postgres"];
const EVENT_TYPES = [
  "loyverse_linked",
  "loyverse_created",
  "loyverse_already_linked",
  "loyverse_conflict",
  "loyverse_error",
  "loyverse_updated",
];

const SQL = {
  select: `select auth_user_id::text as uid from ${T} order by id`,
  selectOf: (uid) => `select id from ${T} where auth_user_id = '${uid}'`,
  insert: (uid, type = "loyverse_created") =>
    `insert into ${T} (auth_user_id, trace_id, event_type, detail)
     values ('${uid}', 'forged', '${type}', '{"traceId":"forged","created":true}') returning id`,
  update: (uid) => `update ${T} set event_type = 'loyverse_created', detail = '{}'::jsonb, created_at = '2020-01-01' where auth_user_id = '${uid}' returning id`,
  delete: (uid) => `delete from ${T} where auth_user_id = '${uid}' returning id`,
  truncate: `truncate ${T}`,
};

// Base 0025 con 2 usuarios y 3 eventos escritos por service_role (como la Edge).
async function seededDatabase0025() {
  const db = await createDatabase({ upTo: "0025" });
  await commitAs(db, POSTGRES, `insert into auth.users (id, email) values ('${UID_A}', 'a@test.local'), ('${UID_B}', 'b@test.local')`);
  await commitAs(
    db,
    SERVICE,
    `insert into ${T} (id, auth_user_id, trace_id, event_type, detail, created_at) values
       ('${EV_A1}', '${UID_A}', 'trace-a1', 'loyverse_created', '{"created":true,"id":"lv-a","traceId":"trace-a1"}', '2026-09-01T10:00:00Z'),
       ('${EV_A2}', '${UID_A}', 'trace-a2', 'loyverse_error',   '{"message":"Loyverse request failed with 503","status":503,"traceId":"trace-a2"}', '2026-09-02T10:00:00Z'),
       ('${EV_B1}', '${UID_B}', 'trace-b1', 'loyverse_linked',  '{"via":"email","id":"lv-b","traceId":"trace-b1"}', '2026-09-03T10:00:00Z')`
  );
  return db;
}

async function rowsSnapshot(db) {
  return commitAs(
    db,
    POSTGRES,
    `select id::text, auth_user_id::text, trace_id, event_type, detail, created_at from ${T} order by id`
  );
}

async function schemaSnapshot(db) {
  const q = (sql) => commitAs(db, POSTGRES, sql);
  return {
    columns: await q(`select column_name, data_type, is_nullable, column_default
                        from information_schema.columns
                       where table_schema = 'public' and table_name = 'customer_sync_events'
                       order by ordinal_position`),
    constraints: await q(`select conname, contype, pg_get_constraintdef(oid) as def
                            from pg_constraint where conrelid = '${T}'::regclass order by conname`),
    indexes: await q(`select indexname, indexdef from pg_indexes
                       where schemaname = 'public' and tablename = 'customer_sync_events' order by indexname`),
    triggers: await q(`select tgname from pg_trigger where tgrelid = '${T}'::regclass and not tgisinternal order by tgname`),
    rls: await q(`select relrowsecurity, relforcerowsecurity from pg_class where oid = '${T}'::regclass`),
  };
}

async function privileges(db) {
  const rows = await commitAs(
    db,
    POSTGRES,
    `select r as role, p as priv, has_table_privilege(r, '${T}', p) as granted
       from unnest($1::text[]) r, unnest($2::text[]) p`,
    [ROLES, PRIVS]
  );
  const out = {};
  for (const { role, priv, granted } of rows) {
    out[role] ??= [];
    if (granted) out[role].push(priv);
  }
  for (const role of ROLES) out[role].sort();
  return out;
}

async function policies(db) {
  return commitAs(
    db,
    POSTGRES,
    `select policyname, permissive, roles::text[] as roles, cmd, qual, with_check
       from pg_policies where schemaname = 'public' and tablename = 'customer_sync_events'
      order by policyname`
  );
}

// Ejecuta `sql` como `who` tras re-otorgar privilegios (defensa en
// profundidad). Siempre hace rollback.
async function asWhoAfterRegrant(db, who, grantSql, sql) {
  let outcome;
  try {
    await db.transaction(async (tx) => {
      await tx.exec(grantSql);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ role: who.role, sub: who.uid }),
      ]);
      await tx.exec(`set local role ${who.role}`);
      try {
        const res = await tx.query(sql);
        outcome = { ok: true, rows: res.rows };
      } catch (error) {
        outcome = { ok: false, code: error.code, error: error.message };
      }
      await tx.rollback();
    });
  } catch {
    // rollback explícito
  }
  return outcome;
}

const ALL_PRIVS = [...PRIVS].sort();
const isPermissionDenied = (r) => r.ok === false && r.code === "42501" && /permission denied/.test(r.error);
const isRlsViolation = (r) => r.ok === false && r.code === "42501" && /row-level security/.test(r.error);

let pre; // 0025 (estado actual en producción)
let post; // 0025 + datos + 0026
let preSchema;
let preRows;
let prePrivs;
before(async () => {
  pre = await seededDatabase0025();
  post = await seededDatabase0025();
  preSchema = await schemaSnapshot(post);
  preRows = await rowsSnapshot(post);
  prePrivs = await privileges(post);
  await post.exec(MIGRATION_0026);
});

// ---------------------------------------------------------------
// ANTES de 0026: documenta el comportamiento real (vulnerable).
// ---------------------------------------------------------------
test("antes de 0026: grants por defecto completos y policy FOR ALL", async () => {
  const privs = await privileges(pre);
  for (const role of ROLES) assert.deepEqual(privs[role], ALL_PRIVS, `${role}: todos los privilegios`);
  const pols = await policies(pre);
  assert.equal(pols.length, 1);
  assert.equal(pols[0].policyname, "sync_events_own_all");
  assert.equal(pols[0].cmd, "ALL");
});

test("antes de 0026: authenticated propio puede SELECT/INSERT/UPDATE/DELETE (y TRUNCATE en SQL)", async () => {
  const sel = await runAs(pre, asUser(UID_A), SQL.select);
  assert.equal(sel.ok, true);
  assert.equal(sel.rows.length, 2);
  assert.ok(sel.rows.every((r) => r.uid === UID_A), "solo ve sus filas");

  const ins = await runAs(pre, asUser(UID_A), SQL.insert(UID_A));
  assert.equal(ins.ok, true, "INSERT de un evento fabricado");
  assert.equal(ins.rows.length, 1);
  const upd = await runAs(pre, asUser(UID_A), SQL.update(UID_A));
  assert.equal(upd.ok, true);
  assert.equal(upd.rows.length, 2, "UPDATE de sus eventos (incluidos los de service_role)");
  const del = await runAs(pre, asUser(UID_A), SQL.delete(UID_A));
  assert.equal(del.ok, true);
  assert.equal(del.rows.length, 2, "DELETE de sus eventos");
  const tru = await runAs(pre, asUser(UID_A), SQL.truncate);
  assert.equal(tru.ok, true, "TRUNCATE no lo cubre RLS");
});

test("antes de 0026: authenticated ajeno — SELECT 0 filas, INSERT bloqueado por RLS, UPDATE/DELETE 0 filas", async () => {
  const sel = await runAs(pre, asUser(UID_A), SQL.selectOf(UID_B));
  assert.equal(sel.ok, true);
  assert.equal(sel.rows.length, 0);
  assert.ok(isRlsViolation(await runAs(pre, asUser(UID_A), SQL.insert(UID_B))));
  const upd = await runAs(pre, asUser(UID_A), SQL.update(UID_B));
  assert.equal(upd.ok, true);
  assert.equal(upd.rows.length, 0);
  const del = await runAs(pre, asUser(UID_A), SQL.delete(UID_B));
  assert.equal(del.ok, true);
  assert.equal(del.rows.length, 0);
});

test("antes de 0026: anon — SELECT/UPDATE/DELETE 0 filas (RLS, sin error), INSERT bloqueado por RLS, TRUNCATE permitido en SQL", async () => {
  const sel = await runAs(pre, ANON, SQL.select);
  assert.equal(sel.ok, true);
  assert.equal(sel.rows.length, 0);
  assert.ok(isRlsViolation(await runAs(pre, ANON, SQL.insert(UID_A))));
  for (const sql of [SQL.update(UID_A), SQL.delete(UID_A)]) {
    const r = await runAs(pre, ANON, sql);
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 0);
  }
  assert.equal((await runAs(pre, ANON, SQL.truncate)).ok, true);
});

// ---------------------------------------------------------------
// DESPUÉS de 0026.
// ---------------------------------------------------------------
test("0026: grants exactos — anon nada, authenticated solo SELECT, service_role y postgres intactos", async () => {
  const privs = await privileges(post);
  assert.deepEqual(privs.anon, []);
  assert.deepEqual(privs.authenticated, ["SELECT"]);
  assert.deepEqual(privs.service_role, prePrivs.service_role);
  assert.deepEqual(privs.service_role, ALL_PRIVS);
  assert.deepEqual(privs.postgres, prePrivs.postgres);
  assert.deepEqual(privs.postgres, ALL_PRIVS);
  const [{ n }] = await commitAs(
    post,
    POSTGRES,
    `select count(*)::int as n from pg_attribute where attrelid = '${T}'::regclass and attacl is not null`
  );
  assert.equal(n, 0, "sin privilegios por columna");
});

test("0026: RLS sigue activa y la única policy es sync_events_select_own (FOR SELECT TO authenticated)", async () => {
  const pols = await policies(post);
  assert.deepEqual(pols, [
    {
      policyname: "sync_events_select_own",
      permissive: "PERMISSIVE",
      roles: ["authenticated"],
      cmd: "SELECT",
      qual: "(auth.uid() = auth_user_id)",
      with_check: null,
    },
  ]);
  const [rls] = await commitAs(post, POSTGRES, `select relrowsecurity, relforcerowsecurity from pg_class where oid = '${T}'::regclass`);
  assert.equal(rls.relrowsecurity, true);
  assert.equal(rls.relforcerowsecurity, false);
});

test("0026: authenticated propio — SELECT permitido; INSERT/UPDATE/DELETE/TRUNCATE → 42501 permission denied", async () => {
  const sel = await runAs(post, asUser(UID_A), SQL.select);
  assert.equal(sel.ok, true);
  assert.equal(sel.rows.length, 2);
  assert.ok(sel.rows.every((r) => r.uid === UID_A), "solo ve sus filas");
  for (const sql of [SQL.insert(UID_A), SQL.update(UID_A), SQL.delete(UID_A), SQL.truncate]) {
    const r = await runAs(post, asUser(UID_A), sql);
    assert.ok(isPermissionDenied(r), `${sql.slice(0, 40)} → ${JSON.stringify(r)}`);
  }
});

test("0026: authenticated ajeno — SELECT 0 filas; INSERT/UPDATE/DELETE → 42501", async () => {
  const sel = await runAs(post, asUser(UID_A), SQL.selectOf(UID_B));
  assert.equal(sel.ok, true);
  assert.equal(sel.rows.length, 0);
  for (const sql of [SQL.insert(UID_B), SQL.update(UID_B), SQL.delete(UID_B)]) {
    assert.ok(isPermissionDenied(await runAs(post, asUser(UID_A), sql)));
  }
});

test("0026: anon sin privilegios — SELECT/INSERT/UPDATE/DELETE/TRUNCATE → 42501", async () => {
  for (const sql of [SQL.select, SQL.insert(UID_A), SQL.update(UID_A), SQL.delete(UID_A), SQL.truncate]) {
    assert.ok(isPermissionDenied(await runAs(post, ANON, sql)), sql.slice(0, 40));
  }
});

test("0026: service_role (writer de la Edge) puede INSERT y SELECT; los 6 event_type siguen válidos", async () => {
  for (const type of EVENT_TYPES) {
    const r = await runAs(post, SERVICE, SQL.insert(UID_A, type));
    assert.equal(r.ok, true, type);
  }
  const bad = await runAs(post, SERVICE, SQL.insert(UID_A, "phase2a_probe"));
  assert.equal(bad.code, "23514", "la CHECK de event_type no cambió");
  const sel = await runAs(post, SERVICE, `select count(*)::int as n from ${T}`);
  assert.equal(sel.rows[0].n, 3, "service_role ve todos los eventos");
});

test("0026: el error de permiso precede a la CHECK y al filtro (base de las sondas no destructivas)", async () => {
  const probes = [
    SQL.insert(UID_A, "phase2a_probe"),
    `update ${T} set detail = '{}'::jsonb where id = '00000000-0000-0000-0000-000000000000'`,
    `delete from ${T} where id = '00000000-0000-0000-0000-000000000000'`,
  ];
  for (const sql of probes) assert.ok(isPermissionDenied(await runAs(post, asUser(UID_A), sql)), sql.slice(0, 40));
});

test("0026: defensa en profundidad — un GRANT accidental no reabre la escritura (RLS sin policy de escritura)", async () => {
  const grant = `grant insert, update, delete on table ${T} to authenticated`;
  const ins = await asWhoAfterRegrant(post, asUser(UID_A), grant, SQL.insert(UID_A));
  assert.ok(isRlsViolation(ins), `INSERT tras re-grant → ${JSON.stringify(ins)}`);
  const upd = await asWhoAfterRegrant(post, asUser(UID_A), grant, SQL.update(UID_A));
  assert.equal(upd.ok, true);
  assert.equal(upd.rows.length, 0, "UPDATE tras re-grant no ve filas");
  const del = await asWhoAfterRegrant(post, asUser(UID_A), grant, SQL.delete(UID_A));
  assert.equal(del.ok, true);
  assert.equal(del.rows.length, 0, "DELETE tras re-grant no ve filas");
  assert.deepEqual(await rowsSnapshot(post), preRows, "ninguna fila cambió");
});

test("0026: estructura idéntica (columnas, tipos, nullability, defaults, PK, FK, CHECK, índices, triggers, RLS)", async () => {
  assert.deepEqual(await schemaSnapshot(post), preSchema);
  assert.equal(preSchema.triggers.length, 0);
  assert.equal(preSchema.indexes.length, 2);
});

test("0026: no modifica datos (count, id, auth_user_id, trace_id, event_type, detail, created_at)", async () => {
  const rows = await rowsSnapshot(post);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows, preRows);
});

test("0026: ON DELETE CASCADE desde auth.users sigue funcionando", async () => {
  let remaining;
  try {
    await post.transaction(async (tx) => {
      await tx.exec(`delete from auth.users where id = '${UID_B}'`);
      const res = await tx.query(`select auth_user_id::text as uid from ${T}`);
      remaining = res.rows.map((r) => r.uid);
      await tx.rollback();
    });
  } catch {
    // rollback explícito
  }
  assert.equal(remaining.length, 2);
  assert.ok(remaining.every((uid) => uid === UID_A), "los eventos de B se borraron en cascada");
  assert.equal((await rowsSnapshot(post)).length, 3, "rollback: fixtures intactos");
});

test("0026: idempotente — aplicarla otra vez no falla ni cambia grants, policies, estructura ni datos", async () => {
  const db = await seededDatabase0025();
  await db.exec(MIGRATION_0026);
  const once = { privs: await privileges(db), pols: await policies(db), schema: await schemaSnapshot(db), rows: await rowsSnapshot(db) };
  await db.exec(MIGRATION_0026);
  const twice = { privs: await privileges(db), pols: await policies(db), schema: await schemaSnapshot(db), rows: await rowsSnapshot(db) };
  assert.deepEqual(twice, once);
});

test("instalación limpia (todas las migraciones) llega al mismo estado de permisos que aplicar 0026 sobre 0025", async () => {
  const fresh = await createDatabase();
  assert.deepEqual(await privileges(fresh), await privileges(post));
  assert.deepEqual(await policies(fresh), await policies(post));
});
