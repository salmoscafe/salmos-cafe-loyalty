// ---------------------------------------------------------------
// rpc-authorization.test.mjs — tests de AUTORIZACIÓN reales sobre
// Postgres 17 (PGlite) con TODAS las migraciones aplicadas y los
// default privileges de Supabase emulados (ver helpers/supabaseSqlHarness).
//
// No son tests de mocks: cada caso ejecuta la RPC real como
// anon / authenticated(uid) / service_role y comprueba si Postgres la
// permite o la rechaza. Cubre la vulnerabilidad corregida en 0018:
//   * anon/authenticated podían invocar las RPCs SECURITY DEFINER;
//   * assert_loyalty_actor confiaba en p_actor_role/p_actor_id.
// Además verifica que el camino legítimo (Edge → service_role con el
// actor resuelto de public.profiles) y las reglas de negocio siguen
// funcionando.
// ---------------------------------------------------------------
import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  createDatabase,
  runAs,
  commitAs,
  asUser,
  ANON,
  SERVICE,
  POSTGRES,
} from "./helpers/supabaseSqlHarness.mjs";

// Usuarios (auth.users.id = profiles.id)
const UID_A = "aaaaaaaa-0000-4000-8000-000000000001"; // customer A
const UID_B = "bbbbbbbb-0000-4000-8000-000000000002"; // customer B
const UID_S = "cccccccc-0000-4000-8000-000000000003"; // staff activo
const UID_S_OFF = "dddddddd-0000-4000-8000-000000000004"; // staff inactivo
const UID_X = "eeeeeeee-0000-4000-8000-000000000005"; // admin activo
// customers.id
const CUST_A = "aaaaaaaa-1111-4000-8000-000000000001";
const CUST_B = "bbbbbbbb-1111-4000-8000-000000000002";

const INTERNAL_RPCS = [
  "assert_loyalty_actor",
  "visit_summary",
  "register_visit",
  "register_visit_with_receipt",
  "cancel_visit",
  "cancel_visit_by_sale",
  "redeem_reward",
  "verify_reward_claim",
  "constant_time_equal",
];

let db;
let visitB; // visita activa de B (creada por el sync)
let rewardB; // recompensa disponible de B (7 visitas)

const isDenied = (res) =>
  res.ok === false && (res.code === "42501" || /permission denied|No autorizado/.test(res.error));

function registerSql() {
  return `select public.register_visit($1::uuid, $2, $3::numeric, $4::date, null, null, $5, $6, $7) as r`;
}

// Fechas pasadas consecutivas (máx. 1 visita/día).
function pastDate(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return d.toISOString().slice(0, 10);
}

before(async () => {
  db = await createDatabase();
  await commitAs(
    db,
    POSTGRES,
    `insert into auth.users (id, email) values
       ('${UID_A}', 'a@test.local'), ('${UID_B}', 'b@test.local'),
       ('${UID_S}', 's@test.local'), ('${UID_S_OFF}', 'soff@test.local'),
       ('${UID_X}', 'x@test.local')`
  );
  await commitAs(db, POSTGRES, `update public.profiles set role = 'staff' where id = '${UID_S}'`);
  await commitAs(db, POSTGRES, `update public.profiles set role = 'staff', active = false where id = '${UID_S_OFF}'`);
  await commitAs(db, POSTGRES, `update public.profiles set role = 'admin' where id = '${UID_X}'`);
  await commitAs(
    db,
    POSTGRES,
    `insert into public.customers (id, auth_user_id, name, phone, email, customer_code) values
       ('${CUST_A}', '${UID_A}', 'Cliente A', '+526640000001', 'a@test.local', 'SC-AAAAAAAA'),
       ('${CUST_B}', '${UID_B}', 'Cliente B', '+526640000002', 'b@test.local', 'SC-BBBBBBBB')`
  );

  // B: 7 visitas por el camino legítimo (sync de Loyverse = system).
  for (let i = 7; i >= 1; i--) {
    await commitAs(db, SERVICE, registerSql(), [
      CUST_B, `LV-${1000 + i}`, 80, pastDate(i), "loyverse", "loyverse-receipts-sync", "system",
    ]);
  }
  // + una visita extra en el nuevo ciclo para probar cancelaciones.
  await commitAs(db, SERVICE, registerSql(), [
    CUST_B, "LV-2000", 80, pastDate(0), "loyverse", "loyverse-receipts-sync", "system",
  ]);
  visitB = (await commitAs(db, POSTGRES, `select id from public.loyalty_visits where external_sale_id = 'LV-2000'`))[0].id;
  rewardB = (await commitAs(db, POSTGRES, `select id from public.rewards where customer_id = '${CUST_B}' and status = 'available'`))[0]?.id;
});

// ---------------------------------------------------------------
// Matriz de privilegios EXECUTE
// ---------------------------------------------------------------
test("grants: RPCs internas solo service_role (anon/authenticated/PUBLIC sin EXECUTE)", async () => {
  const rows = await commitAs(
    db,
    POSTGRES,
    `select p.proname,
            has_function_privilege('anon', p.oid, 'execute')          as anon,
            has_function_privilege('authenticated', p.oid, 'execute') as authd,
            has_function_privilege('service_role', p.oid, 'execute')  as svc,
            exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     where a.grantee = 0 and a.privilege_type = 'EXECUTE')  as public_exec
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1)`,
    [INTERNAL_RPCS]
  );
  assert.equal(rows.length >= INTERNAL_RPCS.length, true, "todas las RPCs existen");
  for (const r of rows) {
    assert.equal(r.anon, false, `${r.proname}: anon NO debe tener EXECUTE`);
    assert.equal(r.authd, false, `${r.proname}: authenticated NO debe tener EXECUTE`);
    assert.equal(r.svc, true, `${r.proname}: service_role SÍ debe tener EXECUTE`);
    assert.equal(r.public_exec, false, `${r.proname}: PUBLIC NO debe tener EXECUTE`);
  }
});

test("grants: login por alias sigue disponible para anon y authenticated (decisión explícita)", async () => {
  for (const who of [ANON, asUser(UID_A)]) {
    const res = await runAs(db, who, `select public.phone_is_registered('+526640000001') as v`);
    assert.equal(res.ok, true, res.error);
    assert.equal(res.rows[0].v, true);
  }
});

test("grants: funciones de trigger no invocables por anon/authenticated y los triggers siguen funcionando", async () => {
  const rows = await commitAs(
    db,
    POSTGRES,
    `select p.proname, has_function_privilege('anon', p.oid, 'execute') anon,
            has_function_privilege('authenticated', p.oid, 'execute') authd
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('handle_new_user', 'set_updated_at')`
  );
  for (const r of rows) {
    assert.equal(r.anon, false, r.proname);
    assert.equal(r.authd, false, r.proname);
  }
  // handle_new_user sigue creando el perfil customer al registrarse
  // (el trigger AFTER INSERT dispara aunque nadie tenga EXECUTE directo).
  await db.transaction(async (tx) => {
    const u = await tx.query(`insert into auth.users (email) values ('nuevo@test.local') returning id`);
    const pr = await tx.query(`select role from public.profiles where id = $1`, [u.rows[0].id]);
    assert.equal(pr.rows[0]?.role, "customer");
    // set_updated_at sigue actualizando updated_at.
    const before = (await tx.query(`select updated_at from public.profiles where id = $1`, [u.rows[0].id])).rows[0].updated_at;
    await tx.query(`select pg_sleep(0.01)`);
    await tx.query(`update public.profiles set name = 'x' where id = $1`, [u.rows[0].id]);
    const after = (await tx.query(`select updated_at from public.profiles where id = $1`, [u.rows[0].id])).rows[0].updated_at;
    assert.ok(after >= before);
    await tx.rollback();
  });
});

test("default privileges: una función NUEVA en public (con la convención revoke from public) no queda expuesta a anon/authenticated", async () => {
  await db.transaction(async (tx) => {
    await tx.exec(`create function public.zz_future_rpc() returns int language sql security definer as 'select 1';
                   revoke all on function public.zz_future_rpc() from public;`);
    const r = await tx.query(`select has_function_privilege('anon', 'public.zz_future_rpc()', 'execute') as anon,
                                     has_function_privilege('authenticated', 'public.zz_future_rpc()', 'execute') as authd,
                                     has_function_privilege('service_role', 'public.zz_future_rpc()', 'execute') as svc`);
    assert.equal(r.rows[0].anon, false);
    assert.equal(r.rows[0].authd, false);
    assert.equal(r.rows[0].svc, true, "service_role conserva el default de Supabase");
    await tx.rollback();
  });
});

// ---------------------------------------------------------------
// Caso 1 — anon
// ---------------------------------------------------------------
test("Caso 1: anon no puede ejecutar ninguna RPC interna", async () => {
  const calls = [
    [`select public.assert_loyalty_actor('x', 'staff', null)`],
    [`select public.visit_summary($1::uuid)`, [visitB]],
    [registerSql(), [CUST_A, "ANON-1", 60, null, "manual", UID_S, "staff"]],
    [`select public.register_visit_with_receipt($1::uuid, 'ANON-2', 60)`, [CUST_A]],
    [`select public.cancel_visit($1::uuid, $2, 'staff')`, [visitB, UID_S]],
    [`select public.cancel_visit_by_sale('LV-2000', $1, 'staff')`, [UID_S]],
    [`select public.redeem_reward($1::uuid, $2, 'admin')`, [rewardB, UID_X]],
    [`select public.verify_reward_claim($1::uuid, 'x', $2, 'staff')`, [rewardB, UID_S]],
    [`select public.constant_time_equal('a', 'a')`],
  ];
  for (const [sql, params] of calls) {
    const res = await runAs(db, ANON, sql, params || []);
    assert.equal(isDenied(res), true, `anon debió ser rechazado: ${sql} → ${JSON.stringify(res)}`);
  }
});

// ---------------------------------------------------------------
// Caso 2 — authenticated customer
// ---------------------------------------------------------------
test("Caso 2: customer autenticado no puede auto-registrarse visitas (vector original)", async () => {
  const res = await runAs(db, asUser(UID_A), registerSql(), [CUST_A, "SELF-1", 60, null, "manual", CUST_A, "customer"]);
  assert.equal(isDenied(res), true, JSON.stringify(res));
});

test("Caso 2: customer no puede registrar visitas para otro customer", async () => {
  const res = await runAs(db, asUser(UID_A), registerSql(), [CUST_B, "OTHER-1", 60, null, "manual", CUST_A, "customer"]);
  assert.equal(isDenied(res), true, JSON.stringify(res));
});

test("Caso 2: customer no puede cancelar visitas ajenas (por id ni por sale_id)", async () => {
  const byId = await runAs(db, asUser(UID_A), `select public.cancel_visit($1::uuid, $2, 'customer')`, [visitB, CUST_A]);
  const bySale = await runAs(db, asUser(UID_A), `select public.cancel_visit_by_sale('LV-2000', $1, 'customer')`, [CUST_A]);
  assert.equal(isDenied(byId), true, JSON.stringify(byId));
  assert.equal(isDenied(bySale), true, JSON.stringify(bySale));
  const still = await commitAs(db, POSTGRES, `select status from public.loyalty_visits where id = $1`, [visitB]);
  assert.equal(still[0].status, "active");
});

test("Caso 2: customer no puede redimir ni verificar recompensas ajenas", async () => {
  assert.ok(rewardB, "B tiene una recompensa disponible");
  const redeem = await runAs(db, asUser(UID_A), `select public.redeem_reward($1::uuid, $2, 'customer')`, [rewardB, CUST_A]);
  const verify = await runAs(db, asUser(UID_A), `select public.verify_reward_claim($1::uuid, 'x', $2, 'staff')`, [rewardB, UID_S]);
  assert.equal(isDenied(redeem), true, JSON.stringify(redeem));
  assert.equal(isDenied(verify), true, JSON.stringify(verify));
});

test("Caso 2: customer no puede escalar a staff/admin editando profiles ni tocar otro customer", async () => {
  const escalate = await runAs(db, asUser(UID_A), `update public.profiles set role = 'admin' where id = $1 returning id`, [UID_A]);
  assert.equal(escalate.ok === false || escalate.rows.length === 0, true, "no puede cambiar su propio rol");
  const other = await runAs(db, asUser(UID_A), `update public.customers set name = 'hack' where id = $1 returning id`, [CUST_B]);
  assert.equal(other.ok === false || other.rows.length === 0, true, "no puede modificar otro customer");
  const excl = await runAs(db, asUser(UID_A), `update public.customers set exclude_loyalty = true where id = $1 returning id`, [CUST_A]);
  assert.equal(excl.ok, false, "no puede tocar exclude_loyalty");
  const directVisit = await runAs(
    db,
    asUser(UID_A),
    `insert into public.loyalty_visits (customer_id, cycle_id, external_sale_id, amount, visit_date)
     select $1::uuid, c.id, 'DIRECT-1', 60, current_date from public.loyalty_cycles c limit 1 returning id`,
    [CUST_A]
  );
  assert.equal(directVisit.ok === false || directVisit.rows.length === 0, true, "no puede insertar visitas directo en la tabla");
});

// ---------------------------------------------------------------
// Caso 5 — spoofing de p_actor_role / p_actor_id
// ---------------------------------------------------------------
test("Caso 5: customer autenticado con p_actor_role='admin' y p_actor_id de otro usuario → rechazado", async () => {
  for (const [actorId, role] of [[UID_X, "admin"], [UID_S, "staff"], [UID_B, "admin"], ["system", "system"]]) {
    const res = await runAs(db, asUser(UID_A), registerSql(), [CUST_A, `SPOOF-${role}-${actorId}`, 60, null, "manual", actorId, role]);
    assert.equal(isDenied(res), true, `${role}/${actorId}: ${JSON.stringify(res)}`);
  }
});

test("Caso 5: incluso vía service_role, p_actor_role no es autoridad: debe coincidir con public.profiles", async () => {
  const cases = [
    { actor: UID_A, role: "admin", why: "un customer afirmando ser admin" },
    { actor: UID_A, role: "staff", why: "un customer afirmando ser staff" },
    { actor: UID_S, role: "admin", why: "staff afirmando ser admin" },
    { actor: UID_S_OFF, role: "staff", why: "staff inactivo" },
    { actor: "11111111-1111-4111-8111-111111111111", role: "staff", why: "perfil inexistente" },
    { actor: "no-es-uuid", role: "admin", why: "actor no uuid" },
    { actor: CUST_A, role: "customer", why: "rol customer ya no muta el motor" },
  ];
  for (const c of cases) {
    const res = await runAs(db, SERVICE, registerSql(), [CUST_A, `SVC-${c.role}-${c.actor}`, 60, null, "manual", c.actor, c.role]);
    assert.equal(res.ok, false, `${c.why} debió rechazarse`);
  }
});

// ---------------------------------------------------------------
// Caso 6 — identidad: auth.uid() A operando sobre B
// ---------------------------------------------------------------
test("Caso 6: con auth.uid()=A, ningún payload permite operar sobre B", async () => {
  const attempts = [
    [registerSql(), [CUST_B, "ID-1", 60, null, "manual", CUST_B, "customer"]],
    [registerSql(), [CUST_B, "ID-2", 60, null, "manual", UID_B, "customer"]],
    [`select public.cancel_visit($1::uuid, $2, 'customer')`, [visitB, CUST_B]],
    [`select public.redeem_reward($1::uuid, $2, 'customer')`, [rewardB, CUST_B]],
  ];
  for (const [sql, params] of attempts) {
    const res = await runAs(db, asUser(UID_A), sql, params);
    assert.equal(isDenied(res), true, `${sql} → ${JSON.stringify(res)}`);
  }
  const ownRead = await runAs(db, asUser(UID_A), `select count(*)::int n from public.loyalty_visits where customer_id = $1`, [CUST_B]);
  assert.equal(ownRead.rows[0].n, 0, "RLS: A no ve visitas de B");
});

// ---------------------------------------------------------------
// Caso 3 — staff (camino legítimo: Edge → service_role con actor de profiles)
// ---------------------------------------------------------------
test("Caso 3: staff con JWT propio tampoco llama la RPC directo (debe pasar por la Edge)", async () => {
  const res = await runAs(db, asUser(UID_S), registerSql(), [CUST_A, "STAFF-DIRECT", 60, null, "manual", UID_S, "staff"]);
  assert.equal(isDenied(res), true, JSON.stringify(res));
});

test("Caso 3: staff activo vía Edge (service_role) registra y cancela visitas", async () => {
  const res = await runAs(
    db,
    SERVICE,
    `with v as (select (public.register_visit($1::uuid, 'STAFF-OK', 60, null, null, null, 'manual', $2, 'staff') ->> 'visit_id')::uuid id)
     select public.cancel_visit(v.id, $2, 'staff') ->> 'status' as status from v`,
    [CUST_A, UID_S]
  );
  assert.equal(res.ok, true, res.error);
  assert.equal(res.rows[0].status, "cancelled");
});

test("Caso 3: staff inactivo vía Edge es rechazado por la base (defensa en profundidad)", async () => {
  const res = await runAs(db, SERVICE, registerSql(), [CUST_A, "STAFF-OFF", 60, null, "manual", UID_S_OFF, "staff"]);
  assert.equal(isDenied(res), true, JSON.stringify(res));
});

// ---------------------------------------------------------------
// Caso 4 — admin
// ---------------------------------------------------------------
test("Caso 4: admin activo conserva sus operaciones (registrar, cancelar, verificar/redimir pasa la guarda)", async () => {
  const res = await runAs(
    db,
    SERVICE,
    `with v as (select (public.register_visit($1::uuid, 'ADMIN-OK', 60, null, null, null, 'manual', $2, 'admin') ->> 'visit_id')::uuid id)
     select public.cancel_visit(v.id, $2, 'admin') ->> 'status' as status from v`,
    [CUST_A, UID_X]
  );
  assert.equal(res.ok, true, res.error);
  assert.equal(res.rows[0].status, "cancelled");
  // redeem sin claim verified: la guarda de actor PASA y la regla de 0017 decide.
  const redeem = await runAs(db, SERVICE, `select public.redeem_reward($1::uuid, $2, 'admin')`, [rewardB, UID_X]);
  assert.equal(redeem.ok, false);
  assert.doesNotMatch(redeem.error, /No autorizado/);
});

// ---------------------------------------------------------------
// Regresión — el sync (system) y las reglas de negocio no cambian
// ---------------------------------------------------------------
test("regresión: el sync de Loyverse (service_role + system) sigue registrando y cancelando por sale_id", async () => {
  const res = await runAs(db, SERVICE, `select public.cancel_visit_by_sale('LV-2000', 'loyverse-receipts-sync', 'system') ->> 'status' as status`);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.rows[0].status, "cancelled");
});

test("regresión: 7 visitas generan la recompensa y se respetan $50 mínimo y 1 visita/día", async () => {
  assert.ok(rewardB, "7 visitas → recompensa disponible");
  const minAmount = await runAs(db, SERVICE, registerSql(), [CUST_A, "MIN-1", 49, null, "manual", UID_S, "staff"]);
  assert.equal(minAmount.ok, false);
  assert.match(minAmount.error, /mínimo/i);
  const day = pastDate(3);
  const first = await runAs(
    db,
    SERVICE,
    `select public.register_visit($1::uuid, 'DAY-1', 60, $2::date, null, null, 'manual', $3, 'staff') ->> 'ok' as ok`,
    [CUST_A, day, UID_S]
  );
  assert.equal(first.ok, true, first.error);
  const twice = await runAs(
    db,
    SERVICE,
    `select public.register_visit($1::uuid, 'DAY-1', 60, $2::date, null, null, 'manual', $3, 'staff'),
            public.register_visit($1::uuid, 'DAY-2', 60, $2::date, null, null, 'manual', $3, 'staff')`,
    [CUST_A, day, UID_S]
  );
  assert.equal(twice.ok, false, "segunda visita del mismo día debe rechazarse");
  assert.match(twice.error, /ya registró una visita válida hoy/);
});
