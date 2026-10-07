// ---------------------------------------------------------------
// phone-identity-migrations.test.mjs — 0021 / 0022 / 0023 sobre
// Postgres 17 real (PGlite) con todas las migraciones y los default
// privileges de Supabase emulados (helpers/supabaseSqlHarness).
//   * 0021: normalización legacy de customers.phone a E.164 MX.
//   * 0022: canonical_mx_phone + phone_is_registered (customers +
//           ventana de metadata de registros pendientes).
//   * 0023: el cliente ya no puede actualizar customers.phone.
// ---------------------------------------------------------------
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase, runAs, commitAs, asUser, ANON, SERVICE, POSTGRES, MIGRATIONS_DIR } from "./helpers/supabaseSqlHarness.mjs";

const MIGRATION_0021 = readFileSync(join(MIGRATIONS_DIR, "0021_customers_phone_canonical.sql"), "utf8");
const CODES = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const HOURS = 3600 * 1000;

function makeSeeder(db, prefix) {
  let n = 0;
  return async function seed({ phone = null, meta = {}, customer = true, confirmed = true, ageHours = 0 } = {}) {
    n++;
    const uid = `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
    await commitAs(
      db,
      POSTGRES,
      `insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at, created_at)
       values ($1, $2, $3::jsonb, $4, $5)`,
      [uid, `${prefix}-${n}@test.local`, JSON.stringify(meta), confirmed ? new Date().toISOString() : null,
       new Date(Date.now() - ageHours * HOURS).toISOString()]
    );
    let customerId = null;
    if (customer) {
      const code = `SC-${CODES[n % CODES.length]}${CODES[Math.floor(n / CODES.length) % CODES.length]}${prefix.slice(0, 6).toUpperCase().replace(/[^A-HJ-NP-Z]/g, "Q")}`.slice(0, 11);
      const rows = await commitAs(
        db,
        POSTGRES,
        `insert into public.customers (auth_user_id, name, customer_code, phone) values ($1, 'x', $2, $3) returning id`,
        [uid, code.padEnd(11, "Z"), phone]
      );
      customerId = rows[0].id;
    }
    return { uid, customerId };
  };
}

// ======================= canonical_mx_phone =======================
let db;
before(async () => {
  db = await createDatabase();
});

test("canonical_mx_phone: 10 dígitos, +52, 52 sin +, inválidos y vacío", async () => {
  const cases = [
    ["6645550000", "+526645550000"],
    ["664 555 0000", "+526645550000"],
    ["+526645550000", "+526645550000"],
    ["+52 (664) 555-0000", "+526645550000"],
    ["526645550000", "+526645550000"],
    ["12345", null],
    ["+1 619 555 0000 99", null],
    ["", null],
    [null, null],
  ];
  for (const [input, expected] of cases) {
    const r = await runAs(db, SERVICE, "select public.canonical_mx_phone($1) as c", [input]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.rows[0].c, expected, String(input));
  }
});

test("canonical_mx_phone es privado: anon y authenticated no lo ejecutan", async () => {
  for (const who of [ANON, asUser("aaaaaaaa-0000-4000-8000-000000000001")]) {
    const r = await runAs(db, who, "select public.canonical_mx_phone('6645550000')");
    assert.equal(r.ok, false);
    assert.match(r.error, /permission denied/);
  }
});

// ======================= phone_is_registered =======================
test("phone_is_registered: casos 1–9 (siempre booleano, como anon)", async () => {
  const pdb = await createDatabase();
  const seed = makeSeeder(pdb, "bbbbbbbb");
  await seed({ phone: "+526645559001" });                                                       // 1
  await seed({ customer: false, meta: { phone: "+52 6645559002" }, confirmed: true, ageHours: 100 }); // 2
  await seed({ customer: false, meta: { phone: "6645559003" }, confirmed: false, ageHours: 2 });      // 3
  await seed({ customer: false, meta: { phone: "+526645559004" }, confirmed: false, ageHours: 48 });  // 4
  await seed({ phone: null, meta: { phone: "+526645559005" } });                                // 5 customer existe
  await seed({ customer: false, meta: { phone: "+526645559006" } });                            // 6 duplicado
  await seed({ customer: false, meta: { phone: "664 555 9006" } });                             // 6 duplicado
  await seed({ customer: false, meta: { phone: 6645559008 } });                                 // 8 no-string
  await seed({ customer: false, meta: { phone: "   " } });                                      // 9 vacío

  const ask = async (value) => {
    const r = await runAs(pdb, ANON, "select public.phone_is_registered($1) as v", [value]);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(Object.keys(r.rows[0]), ["v"], "solo un booleano");
    assert.equal(typeof r.rows[0].v, "boolean");
    return r.rows[0].v;
  };

  assert.equal(await ask("+526645559001"), true, "1. en customers (+52)");
  assert.equal(await ask("6645559001"), true, "1. en customers (10 dígitos)");
  assert.equal(await ask("664 555 9002"), true, "2. solo metadata confirmada");
  assert.equal(await ask("+526645559003"), true, "3. metadata reciente <24h sin confirmar");
  assert.equal(await ask("6645559004"), false, "4. metadata sin confirmar >24h");
  assert.equal(await ask("6645559005"), false, "5. customer existe → su metadata se ignora");
  assert.equal(await ask("6645559006"), true, "6. metadata duplicada → true");
  assert.equal(await ask("12345"), false, "7. teléfono inválido");
  assert.equal(await ask(""), false, "7. vacío");
  assert.equal(await ask(null), false, "7. null");
  assert.equal(await ask("6645559008"), false, "8. metadata no-string ignorada");
  assert.equal(await ask("6645550000"), false, "9. metadata vacía no reserva nada / número libre");
});

test("phone_is_registered: misma firma y grants (anon/authenticated sí; PUBLIC no)", async () => {
  const [row] = await commitAs(
    db,
    POSTGRES,
    `select pg_get_function_identity_arguments('public.phone_is_registered(text)'::regprocedure) as args,
            pg_get_function_result('public.phone_is_registered(text)'::regprocedure) as result,
            has_function_privilege('anon', 'public.phone_is_registered(text)', 'execute') as anon,
            has_function_privilege('authenticated', 'public.phone_is_registered(text)', 'execute') as authd,
            exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                     where p.oid = 'public.phone_is_registered(text)'::regprocedure
                       and a.grantee = 0) as public_exec`
  );
  assert.deepEqual(row, { args: "p_phone text", result: "boolean", anon: true, authd: true, public_exec: false });
});

// ======================= 0021 normalización legacy =======================
test("0021: normaliza, omite conflictos/ambiguos/inválidos, audita sin teléfono completo y es idempotente", async () => {
  const ldb = await createDatabase({ upTo: "0020" });
  const seed = makeSeeder(ldb, "cccccccc");
  const s1 = await seed({ phone: "6645550001" });        // 1. legacy 10 → canonical
  const s2 = await seed({ phone: "+526645550002" });     // 2. ya canónico
  const s3a = await seed({ phone: "6645550007" });       // 3. legacy que choca con canónico
  const s3b = await seed({ phone: "+526645550007" });
  const s4a = await seed({ phone: "664-555-0008" });     // 4. dos legacy → mismo canónico
  const s4b = await seed({ phone: "526645550008" });
  const s5 = await seed({ phone: "12345" });             // 5. inválido
  const s6 = await seed({ phone: null });
  const s7 = await seed({ phone: "526645550012" });      // 12 dígitos sin + → canonical

  await ldb.exec(MIGRATION_0021);

  const phoneOf = async (id) => (await commitAs(ldb, POSTGRES, "select phone from public.customers where id = $1", [id]))[0].phone;
  const auditOf = async (id) =>
    commitAs(ldb, POSTGRES, "select action, detail from public.audit_logs where customer_id = $1 order by created_at", [id]);

  assert.equal(await phoneOf(s1.customerId), "+526645550001", "1. legacy → canónico");
  assert.equal(await phoneOf(s7.customerId), "+526645550012", "12 dígitos 52 → canónico");
  assert.equal(await phoneOf(s2.customerId), "+526645550002", "2. canónico sin cambio");
  assert.equal(await phoneOf(s3a.customerId), "6645550007", "3. conflicto → no se toca");
  assert.equal(await phoneOf(s3b.customerId), "+526645550007", "3. el otro cliente no se toca");
  assert.equal(await phoneOf(s4a.customerId), "664-555-0008", "4. ambiguo → no se toca");
  assert.equal(await phoneOf(s4b.customerId), "526645550008", "4. ambiguo → no se toca");
  assert.equal(await phoneOf(s5.customerId), "12345", "5. inválido se conserva");
  assert.equal(await phoneOf(s6.customerId), null);

  const a1 = await auditOf(s1.customerId);
  assert.deepEqual(a1.map((r) => r.action), ["phone_normalize_applied"]);
  assert.deepEqual(a1[0].detail, { reason: "normalize", from_format: "10_digits", last2: "01" });
  assert.deepEqual((await auditOf(s3a.customerId))[0].detail.reason, "collides_with_canonical_customer");
  assert.deepEqual((await auditOf(s4a.customerId))[0].detail.reason, "ambiguous_duplicate");
  assert.deepEqual((await auditOf(s4b.customerId))[0].detail.reason, "ambiguous_duplicate");
  assert.deepEqual((await auditOf(s5.customerId))[0], { action: "phone_normalize_skipped", detail: { reason: "invalid_format", from_format: "other", last2: "45" } });
  assert.equal((await auditOf(s2.customerId)).length, 0, "ya canónico: sin auditoría");
  assert.equal((await auditOf(s3b.customerId)).length, 0);

  const allAudit = await commitAs(ldb, POSTGRES, "select detail::text as d from public.audit_logs where action like 'phone_normalize_%'");
  for (const { d } of allAudit) assert.equal(/\d{7,}/.test(d), false, `la auditoría no guarda teléfonos completos: ${d}`);

  // 6. segunda ejecución: 0 cambios, 0 auditorías nuevas
  const before = await commitAs(ldb, POSTGRES, "select id, phone from public.customers order by id");
  const auditCount = allAudit.length;
  await ldb.exec(MIGRATION_0021);
  const after = await commitAs(ldb, POSTGRES, "select id, phone from public.customers order by id");
  assert.deepEqual(after, before);
  const [{ n }] = await commitAs(ldb, POSTGRES, "select count(*)::int as n from public.audit_logs where action like 'phone_normalize_%'");
  assert.equal(n, auditCount);
});

// ======================= 0023 revocar UPDATE de phone =======================
test("0023: el cliente no puede cambiar su teléfono, pero sí crear su perfil con teléfono y editar name/email/profile", async () => {
  const gdb = await createDatabase();
  const seed = makeSeeder(gdb, "dddddddd");
  const owner = await seed({ phone: "+526645551001" });
  const fresh = await seed({ customer: false, meta: { phone: "+526645551002" } });

  const who = asUser(owner.uid);
  const upPhone = await runAs(gdb, who, "update public.customers set phone = '+526645559999' where auth_user_id = $1 returning id", [owner.uid]);
  assert.equal(upPhone.ok, false);
  assert.match(upPhone.error, /permission denied/);

  const upName = await runAs(gdb, who, "update public.customers set name = 'Nuevo', email = 'n@test.local' where auth_user_id = $1 returning name", [owner.uid]);
  assert.equal(upName.ok, true, upName.error);
  assert.equal(upName.rows[0].name, "Nuevo");

  const ins = await runAs(
    gdb,
    asUser(fresh.uid),
    "insert into public.customers (auth_user_id, name, customer_code, phone) values ($1, 'F', 'SC-FFFFFFFF', '+526645551002') returning phone",
    [fresh.uid]
  );
  assert.equal(ins.ok, true, ins.error);
  assert.equal(ins.rows[0].phone, "+526645551002", "INSERT inicial con teléfono sigue permitido");

  const anonUp = await runAs(gdb, ANON, "update public.customers set phone = '+526645550000' returning id");
  assert.equal(anonUp.ok, false);

  const svc = await runAs(gdb, SERVICE, "update public.customers set phone = '+526645557777' where auth_user_id = $1 returning phone", [owner.uid]);
  assert.equal(svc.ok, true, svc.error);
});

test("conflicto al crear perfil con teléfono ajeno: 23505 y el otro cliente queda intacto", async () => {
  const cdb = await createDatabase();
  const seed = makeSeeder(cdb, "eeeeeeee");
  const holder = await seed({ phone: "+526645552001" });
  const newcomer = await seed({ customer: false, meta: { phone: "+526645552001" } });

  const ins = await runAs(
    cdb,
    asUser(newcomer.uid),
    "insert into public.customers (auth_user_id, name, customer_code, phone) values ($1, 'N', 'SC-NNNNNNNN', '+526645552001')",
    [newcomer.uid]
  );
  assert.equal(ins.ok, false);
  assert.equal(ins.code, "23505");
  assert.match(ins.error, /customers_phone_unique_key/);
  const [h] = await commitAs(cdb, POSTGRES, "select phone, auth_user_id from public.customers where id = $1", [holder.customerId]);
  assert.deepEqual(h, { phone: "+526645552001", auth_user_id: holder.uid });
});

// ======================= 0023 contra los permisos REMOTOS reales =======================
// Snapshot remoto (information_schema.column_privileges, UPDATE, 2026-10-07):
//   anon          → las 15 columnas de customers
//   authenticated → email, name, phone, profile
// Se reproduce en dos variantes para anon (GRANT de tabla, que la vista
// expande a todas las columnas, o GRANT por columna explícito) y se
// aplica 0023 encima.
const MIGRATION_0023 = readFileSync(join(MIGRATIONS_DIR, "0023_revoke_customer_phone_update.sql"), "utf8");
const ALL_CUSTOMER_COLUMNS = [
  "auth_user_id", "created_at", "customer_code", "email", "email_verified", "exclude_loyalty", "id",
  "loyverse_customer_id", "loyverse_sync_claim", "loyverse_sync_claim_at", "loyverse_sync_status",
  "name", "phone", "profile", "updated_at",
];

async function updateColumns(conn, role) {
  const rows = await commitAs(
    conn,
    POSTGRES,
    `select column_name from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'customers'
        and privilege_type = 'UPDATE' and grantee = $1 order by column_name`,
    [role]
  );
  return rows.map((r) => r.column_name);
}

// Todo lo que 0023 NO debe tocar: privilegios distintos de UPDATE (tabla y
// columna) para anon/authenticated, todo service_role, y las policies.
async function untouchedSnapshot(conn) {
  return commitAs(
    conn,
    POSTGRES,
    `select
       (select json_agg(x order by x) from (
          select grantee || ':' || privilege_type as x from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'customers'
             and (privilege_type <> 'UPDATE' or grantee = 'service_role')) t) as table_grants,
       (select json_agg(x order by x) from (
          select grantee || ':' || privilege_type || ':' || column_name as x from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'customers'
             and (privilege_type <> 'UPDATE' or grantee = 'service_role')) c) as column_grants,
       (select json_agg(x order by x) from (
          select polname || ':' || polcmd::text || ':' || coalesce(pg_get_expr(polqual, polrelid), '') || ':' ||
                 coalesce(pg_get_expr(polwithcheck, polrelid), '') as x
            from pg_policy where polrelid = 'public.customers'::regclass) p) as policies,
       (select relrowsecurity from pg_class where oid = 'public.customers'::regclass) as rls`
  );
}

for (const variant of ["anon_table_grant", "anon_column_grants"]) {
  test(`0023 sobre permisos remotos reales (${variant}): resultado exacto y sin efectos colaterales`, async () => {
    const rdb = await createDatabase({ upTo: "0022" });

    // ---- reproducir el estado remoto ----
    await commitAs(rdb, POSTGRES, "revoke update on table public.customers from anon, authenticated");
    if (variant === "anon_table_grant") {
      await commitAs(rdb, POSTGRES, "grant update on table public.customers to anon");
    } else {
      await commitAs(rdb, POSTGRES, `grant update (${ALL_CUSTOMER_COLUMNS.join(", ")}) on public.customers to anon`);
    }
    await commitAs(rdb, POSTGRES, "grant update (email, name, phone, profile) on public.customers to authenticated");
    assert.deepEqual(await updateColumns(rdb, "anon"), ALL_CUSTOMER_COLUMNS, "snapshot remoto anon");
    assert.deepEqual(await updateColumns(rdb, "authenticated"), ["email", "name", "phone", "profile"], "snapshot remoto authenticated");

    const seed = makeSeeder(rdb, "ffffffff");
    const owner = await seed({ phone: "+526645553001" });
    const fresh = await seed({ customer: false, meta: { phone: "+526645550000" } });
    const before = await untouchedSnapshot(rdb);

    // ---- aplicar 0023 (dos veces: idempotente) ----
    await rdb.exec(MIGRATION_0023);
    await rdb.exec(MIGRATION_0023);

    // ---- privilegios finales exactos ----
    assert.deepEqual(await updateColumns(rdb, "anon"), [], "anon: UPDATE ninguno");
    assert.deepEqual(await updateColumns(rdb, "authenticated"), ["email", "name", "profile"], "authenticated: UPDATE name, email, profile");
    assert.deepEqual(await updateColumns(rdb, "service_role"), ALL_CUSTOMER_COLUMNS, "service_role: UPDATE completo");
    assert.deepEqual(await untouchedSnapshot(rdb), before, "INSERT/SELECT/DELETE, service_role y policies/RLS sin cambios");

    // ---- comportamiento: anon ----
    for (const sql of [
      "update public.customers set phone = '+526645559999' returning id",
      "update public.customers set name = 'anon' returning id",
    ]) {
      const r = await runAs(rdb, ANON, sql);
      assert.equal(r.ok, false, `anon: ${sql}`);
      assert.match(r.error, /permission denied/);
    }

    // ---- comportamiento: authenticated (su propio customer) ----
    const me = asUser(owner.uid);
    const okUpdates = [
      ["name", "update public.customers set name = 'Nuevo nombre' where auth_user_id = $1 returning name"],
      ["email", "update public.customers set email = 'nuevo@test.local' where auth_user_id = $1 returning email"],
      ["profile", `update public.customers set profile = '{"tema":"oscuro"}'::jsonb where auth_user_id = $1 returning profile`],
    ];
    for (const [col, sql] of okUpdates) {
      const r = await runAs(rdb, me, sql, [owner.uid]);
      assert.equal(r.ok, true, `${col}: ${r.error}`);
      assert.equal(r.rows.length, 1, `${col}: actualiza su propia fila`);
    }
    const phone = await runAs(rdb, me, "update public.customers set phone = '+526645559999' where auth_user_id = $1 returning id", [owner.uid]);
    assert.equal(phone.ok, false);
    assert.match(phone.error, /permission denied/);
    const mixed = await runAs(rdb, me, "update public.customers set name = 'x', phone = '+526645559999' where auth_user_id = $1", [owner.uid]);
    assert.equal(mixed.ok, false, "phone tampoco se cuela junto con columnas permitidas");

    // ---- comportamiento: service_role ----
    const svc = await runAs(rdb, SERVICE, "update public.customers set phone = '+526645553002' where auth_user_id = $1 returning phone", [owner.uid]);
    assert.equal(svc.ok, true, svc.error);
    assert.equal(svc.rows[0].phone, "+526645553002");

    // ---- INSERT inicial con teléfono (ensureCustomerProfile) ----
    const ins = await runAs(
      rdb,
      asUser(fresh.uid),
      `insert into public.customers (auth_user_id, name, email, phone, customer_code)
       values ($1, 'Nuevo', 'nuevo2@test.local', '+526645550000', 'SC-NNNNNNNN') returning phone`,
      [fresh.uid]
    );
    assert.equal(ins.ok, true, ins.error);
    assert.equal(ins.rows[0].phone, "+526645550000");
  });
}
