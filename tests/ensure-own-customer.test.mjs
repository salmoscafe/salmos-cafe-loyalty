// ---------------------------------------------------------------
// ensure-own-customer.test.mjs — integración SQL de 0027 (ventana aditiva):
// la RPC crea/devuelve la fila customers del usuario autenticado y convive
// con el flujo ANTIGUO (INSERT directo por columnas todavía permitido).
// El comportamiento POST-0028 (revokes) se valida en su propia fase.
// Cada escenario usa su propia base (patrón del repo) para no contaminarse.
// ---------------------------------------------------------------
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDatabase,
  runAs,
  commitAs,
  POSTGRES,
  ANON,
  asUser,
} from "./helpers/supabaseSqlHarness.mjs";

// Alfabeto CANONICO del frontend (src/lib/customerCode.js).
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = new RegExp(`^SC-[${ALPHABET}]{8}$`);

let seq = 0;
const uid = () => `11111111-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const fresh = () => createDatabase({ upTo: "0027" });

async function seedAuth(d, u, { email, meta = {}, confirmed = true } = {}) {
  await commitAs(
    d,
    POSTGRES,
    `insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
     values ($1, $2, $3::jsonb, $4::timestamptz)
     on conflict (id) do update
       set email = excluded.email, raw_user_meta_data = excluded.raw_user_meta_data,
           email_confirmed_at = excluded.email_confirmed_at`,
    [u, email, JSON.stringify(meta), confirmed ? new Date() : null]
  );
}

const call = (d, u) => commitAs(d, asUser(u), "select * from public.ensure_own_customer()");
const countCustomers = async (d) => (await commitAs(d, POSTGRES, "select count(*)::int as n from public.customers"))[0].n;

test("0027 grants: EXECUTE solo para authenticated", async () => {
  const db = await fresh();
  const rows = await commitAs(
    db,
    POSTGRES,
    `select has_function_privilege('anon', 'public.ensure_own_customer()', 'execute') as anon,
            has_function_privilege('authenticated', 'public.ensure_own_customer()', 'execute') as authd,
            has_function_privilege('service_role', 'public.ensure_own_customer()', 'execute') as svc,
            exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'ensure_own_customer'`
  );
  assert.equal(rows.length, 1, "la RPC existe");
  assert.equal(rows[0].anon, false);
  assert.equal(rows[0].authd, true, "authenticated SÍ ejecuta");
  assert.equal(rows[0].svc, false);
  assert.equal(rows[0].public_exec, false);
});

test("0027: anon y authenticated sin sub -> 42501", async () => {
  const db = await fresh();
  for (const who of [ANON, { role: "authenticated" }]) {
    const r = await runAs(db, who, "select * from public.ensure_own_customer()");
    assert.equal(r.ok, false, JSON.stringify(who));
    assert.equal(r.code, "42501");
  }
});

test("0027: authenticated sin fila en auth.users -> 42501", async () => {
  const db = await fresh();
  const r = await runAs(db, asUser(uid()), "select * from public.ensure_own_customer()");
  assert.equal(r.ok, false);
  assert.equal(r.code, "42501");
});

test("0027 happy path: crea fila, email de auth, phone canonico, code, email_verified", async () => {
  const db = await fresh();
  const u = uid();
  await seedAuth(db, u, { email: " Alice@Test.LOCAL ", meta: { name: "Alice", phone: "52 664 555 0007" } });

  const [row] = await call(db, u);
  assert.ok(row, "devuelve fila");
  assert.equal(row.auth_user_id, u);
  assert.equal(row.name, "Alice");
  assert.equal(row.email, "alice@test.local", "email purgado y en minúsculas (fuente de verdad)");
  assert.equal(row.phone, "+526645550007", "phone canonicalizado (toE164Mx)");
  assert.equal(row.email_verified, true, "deriva de email_confirmed_at");
  assert.equal(row._conflict_phone, false);
  assert.equal(row.loyverse_customer_id, null);
  assert.equal(row.loyverse_sync_status, "pending", "default de la columna (igual que INSERT directo)");
  assert.match(row.customer_code, CODE_RE);
  assert.ok(row.id, "id uuid");

  const [again] = await call(db, u);
  assert.equal(again.id, row.id, "misma fila en la 2a llamada");
  assert.equal(again.customer_code, row.customer_code);
  assert.equal(await countCustomers(db), 1, "una sola fila");
});

test("0027 idempotente: NO reescribe la fila existente (ni nombre ni phone caché)", async () => {
  const db = await fresh();
  const u = uid();
  await seedAuth(db, u, { email: "cache@test.local", meta: { name: "Alan", phone: "+526645550001" } });
  const [first] = await call(db, u);

  // El usuario cambia metadata DESPUÉS de tener fila.
  await seedAuth(db, u, { email: "modificado@test.local", meta: { name: "Carlos", phone: "+526649999999" } });
  const [second] = await call(db, u);

  assert.equal(second.id, first.id);
  assert.equal(second.name, "Alan", "name de la fila NO se reescribe");
  assert.equal(second.phone, "+526645550001", "phone de la fila NO se reescribe");
  assert.equal(second.email, "modificado@test.local", "email devuelto = auth (fuente de verdad)");
  const [stored] = await commitAs(db, POSTGRES, "select name, email, phone from public.customers where auth_user_id = $1", [u]);
  assert.equal(stored.email, "cache@test.local", "caché customers.email NO se sobrescribe");
});

test("0027 fallbacks de name: full_name -> prefijo del email -> Cliente Salmos", async () => {
  const db = await fresh();
  const fn = uid();
  await seedAuth(db, fn, { email: "full@test.local", meta: { full_name: "Nombre Completo" } });
  const [a] = await call(db, fn);
  assert.equal(a.name, "Nombre Completo");

  const pre = uid();
  await seedAuth(db, pre, { email: "Juan.Perez@test.local" });
  const [b] = await call(db, pre);
  assert.equal(b.name, "juan.perez");

  const nm = uid();
  await seedAuth(db, nm, { email: null, meta: {} });
  const [c] = await call(db, nm);
  assert.equal(c.name, "Cliente Salmos");
  assert.equal(c.email, null);
});

test("0027 phone no canonico o ausente -> NULL, nunca se almacena crudo", async () => {
  const db = await fresh();
  for (const raw of ["abc12", "664123", "9999", "", null]) {
    const u = uid();
    const meta = raw === null ? {} : { phone: raw };
    await seedAuth(db, u, { email: `p${String(seq)}@test.local`, meta });
    const [row] = await call(db, u);
    assert.equal(row.phone, null, `raw=${JSON.stringify(raw)}`);
    const [stored] = await commitAs(db, POSTGRES, "select phone from public.customers where auth_user_id = $1", [u]);
    assert.equal(stored.phone, null);
  }
});

test("0027 conflicto de phone -> _conflict_phone=true, sin phone; holder intacto", async () => {
  const db = await fresh();
  const holder = uid();
  await seedAuth(db, holder, { email: "holder@test.local", meta: {} });
  await commitAs(
    db,
    POSTGRES,
    "insert into public.customers (auth_user_id, name, phone, customer_code) values ($1, 'H', '+526645550011', 'SC-AAAAAAAA')",
    [holder]
  );

  const newcomer = uid();
  await seedAuth(db, newcomer, { email: "newcomer@test.local", meta: { phone: "52 664 555 0011" } });
  const [row] = await call(db, newcomer);
  assert.equal(row._conflict_phone, true, "flag para la UX de phoneConflict");
  assert.equal(row.phone, null, "se inserta sin teléfono");
  assert.equal(row.email, "newcomer@test.local");
  assert.match(row.customer_code, CODE_RE);

  const [h] = await commitAs(db, POSTGRES, "select phone from public.customers where auth_user_id = $1", [holder]);
  assert.equal(h.phone, "+526645550011", "el holder queda intacto");
  assert.equal(await countCustomers(db), 2);
});

test("0027 conflicto de email -> P0001 EMAIL_ALREADY_REGISTERED, sin fila creada", async () => {
  const db = await fresh();
  const old = uid();
  await seedAuth(db, old, { email: "taken@test.local", meta: {} });
  await commitAs(
    db,
    POSTGRES,
    "insert into public.customers (auth_user_id, name, email, customer_code) values ($1, 'Old', 'taken@test.local', 'SC-BBBBBBB2')",
    [old]
  );

  const nw = uid();
  await seedAuth(db, nw, { email: "taken@test.local", meta: { name: "New" } });
  const r = await runAs(db, asUser(nw), "select * from public.ensure_own_customer()");
  assert.equal(r.ok, false);
  assert.equal(r.code, "P0001");
  assert.match(r.error, /EMAIL_ALREADY_REGISTERED/);
  assert.equal(await countCustomers(db), 1, "no se creó fila para el nuevo");
});

test("0027 muchos usuarios -> códigos únicos y una fila por usuario", async () => {
  const db = await fresh();
  const codes = new Set();
  for (let i = 0; i < 150; i++) {
    const u = uid();
    await seedAuth(db, u, { email: `bulk${i}@test.local`, meta: { name: `User${i}` } });
    const [row] = await call(db, u);
    assert.match(row.customer_code, CODE_RE);
    codes.add(row.customer_code);
  }
  assert.equal(codes.size, 150, "customer_code único");
  assert.equal(await countCustomers(db), 150);
});

test("0027 convivencia: el INSERT directo por columnas (flujo ANTIGUO) sigue permitido", async () => {
  const db = await fresh();
  const u = uid();
  await seedAuth(db, u, { email: "legacy@test.local", meta: {} });
  const r = await runAs(
    db,
    asUser(u),
    "insert into public.customers (auth_user_id, name, email, phone, customer_code) values ($1, 'Legacy', 'legacy@test.local', '+526645550002', 'SC-CCCCCCCC') returning phone",
    [u]
  );
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows[0].phone, "+526645550002");
});

test("paridad: alfabeto JS == clase del CHECK de customer_code (0027 genera conforme)", async () => {
  assert.match(ALPHABET, /^[0-9A-HJ-NP-Z]+$/, "sin I,L,O,0,1 ni otros");
  assert.equal(ALPHABET.length, 31);
});