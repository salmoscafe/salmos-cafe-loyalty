// ---------------------------------------------------------------
// login-alias-security.test.mjs — 0020 sobre Postgres real (PGlite)
// con todas las migraciones + default privileges de Supabase emulados.
//   * resolve_email_for_login: solo service_role (la Edge
//     auth-phone-login); devuelve el email de auth.users.
//   * email_is_registered / phone_is_registered: solo booleanos.
// ---------------------------------------------------------------
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createDatabase, runAs, commitAs, asUser, ANON, SERVICE, POSTGRES } from "./helpers/supabaseSqlHarness.mjs";

const UID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const UID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const AUTH_EMAIL_A = "a.privado@test.local";

let db;
before(async () => {
  db = await createDatabase();
  await commitAs(db, POSTGRES, `insert into auth.users (id, email) values ('${UID_A}', '${AUTH_EMAIL_A}'), ('${UID_B}', 'b@test.local')`);
  await commitAs(
    db,
    POSTGRES,
    `insert into public.customers (auth_user_id, name, email, phone, customer_code) values
       ('${UID_A}', 'A', '${AUTH_EMAIL_A}', '+526641234567', 'SC-AAAAAAAA'),
       ('${UID_B}', 'B', 'b@test.local',    '+526649999999', 'SC-BBBBBBBB')`
  );
});

const RESOLVE = "select public.resolve_email_for_login($1) as email";

test("Caso A: teléfono existente → la Edge (service_role) obtiene el email de Auth", async () => {
  // La Edge normaliza a E.164 antes (normalizePhoneForLogin); la RPC
  // compara por dígitos, igual que en 0003.
  for (const phone of ["+526641234567", "+52 (664) 123-4567", "526641234567"]) {
    const r = await runAs(db, SERVICE, RESOLVE, [phone]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.rows[0].email, AUTH_EMAIL_A, phone);
  }
});

test("Caso B: teléfono inexistente → NULL (y la Edge responde genérico)", async () => {
  const r = await runAs(db, SERVICE, RESOLVE, ["+526640000000"]);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows[0].email, null);
});

test("Caso C: anon NO puede descubrir el email de un teléfono existente", async () => {
  const r = await runAs(db, ANON, RESOLVE, ["+526641234567"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /permission denied for function resolve_email_for_login/);
});

test("Caso C: un cliente autenticado tampoco (ni para su propio teléfono ni el ajeno)", async () => {
  for (const phone of ["+526641234567", "+526649999999"]) {
    const r = await runAs(db, asUser(UID_A), RESOLVE, [phone]);
    assert.equal(r.ok, false);
    assert.match(r.error, /permission denied/);
  }
});

test("Caso D: intentos repetidos con distintos teléfonos → siempre denegado, sin variación", async () => {
  const errors = new Set();
  for (let i = 0; i < 25; i++) {
    const phone = i === 7 ? "+526641234567" : `+52664${String(1000000 + i).padStart(7, "0")}`;
    const r = await runAs(db, ANON, RESOLVE, [phone]);
    assert.equal(r.ok, false);
    errors.add(r.error);
  }
  assert.equal(errors.size, 1, "mismo error para teléfonos existentes e inexistentes");
});

test("resolve_email_for_login usa el email de Auth, no customers.email (editable por el cliente)", async () => {
  await db.transaction(async (tx) => {
    await tx.query(`update public.customers set email = 'otro@ataque.test' where auth_user_id = $1`, [UID_A]);
    await tx.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    await tx.exec("set local role service_role");
    const r = await tx.query(RESOLVE, ["+526641234567"]);
    assert.equal(r.rows[0].email, AUTH_EMAIL_A);
    await tx.rollback();
  });
});

test("email_is_registered: solo booleano para anon/authenticated; no devuelve datos", async () => {
  for (const who of [ANON, asUser(UID_B)]) {
    const yes = await runAs(db, who, "select public.email_is_registered($1) as v", [" A.Privado@test.local "]);
    const no = await runAs(db, who, "select public.email_is_registered($1) as v", ["nadie@test.local"]);
    assert.equal(yes.ok, true, yes.error);
    assert.equal(yes.rows[0].v, true);
    assert.equal(no.rows[0].v, false);
    const empty = await runAs(db, who, "select public.email_is_registered($1) as v", [""]);
    assert.equal(empty.rows[0].v, false);
  }
});

test("grants finales del login por alias", async () => {
  const [row] = await commitAs(
    db,
    POSTGRES,
    `select has_function_privilege('anon', 'public.resolve_email_for_login(text)', 'execute')          as resolve_anon,
            has_function_privilege('authenticated', 'public.resolve_email_for_login(text)', 'execute') as resolve_auth,
            has_function_privilege('service_role', 'public.resolve_email_for_login(text)', 'execute')  as resolve_svc,
            has_function_privilege('anon', 'public.email_is_registered(text)', 'execute')              as email_anon,
            has_function_privilege('anon', 'public.phone_is_registered(text)', 'execute')              as phone_anon`
  );
  assert.deepEqual(row, { resolve_anon: false, resolve_auth: false, resolve_svc: true, email_anon: true, phone_anon: true });
});
