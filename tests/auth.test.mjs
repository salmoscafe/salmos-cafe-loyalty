// Suite del flujo de autenticación (auth contraseña + recuperación OTP)
// contra el mock de auth (modo demo). Corre con: node --test tests/
//
// Nota: el mock es estado mutable a nivel de módulo, así que cada test
// usa correos/teléfonos únicos o la cuenta seed javier@example.com.
// Cuenta seed (demo): javier@example.com / demo1234 · +52 664 123 4567.

import test from "node:test";
import assert from "node:assert/strict";

import { authService } from "../src/services/index.js";
import { phoneIdentifierForLogin } from "../src/services/auth/supabaseAuthService.js";

const SEED_EMAIL = "javier@example.com";
const SEED_PHONE = "+52 664 123 4567";
const SEED_PASSWORD = "demo1234";

function uniqueEmail(label) {
  return `auth.test.${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function createAccount(label, overrides = {}) {
  const email = overrides.email || uniqueEmail(label);
  const res = await authService.signUpWithEmail({
    email,
    password: overrides.password || "hola1234",
    name: overrides.name || `Cliente ${label}`,
    phone: overrides.phone || "",
  });
  return { email, res };
}

test("registro exitoso crea cuenta y deja sesión lista (complete)", async () => {
  const { email, res } = await createAccount("signup");
  assert.equal(res.ok, true);
  assert.equal(res.mode, "complete");

  const session = await authService.getSession();
  assert.ok(session?.customer, "la sesión debe existir tras registrarse");
  assert.equal(session.customer.email, email);

  await authService.signOutClient();
  assert.equal(await authService.getSession(), null);
});

test("registro con teléfono permite entrar después por ese teléfono", async () => {
  const phone = "+52 664 555 0001";
  const email = uniqueEmail("phone");
  const res = await authService.signUpWithEmail({ email, password: "hola1234", name: "Por Teléfono", phone });
  assert.equal(res.ok, true);

  await authService.signOutClient();
  const login = await authService.signInWithPassword({ identifier: phone, password: "hola1234" });
  assert.equal(login.ok, true);
  const session = await authService.getSession();
  assert.equal(session.customer.email, email);
});

test("correo duplicado al registrarse devuelve EMAIL_ALREADY_EXISTS", async () => {
  const res = await authService.signUpWithEmail({
    email: SEED_EMAIL,
    password: "hola1234",
    name: "Dupe",
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "EMAIL_ALREADY_EXISTS");
});

test("contraseña débil devuelve WEAK_PASSWORD", async () => {
  const res = await authService.signUpWithEmail({
    email: uniqueEmail("weak"),
    password: "123",
    name: "Débil",
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "WEAK_PASSWORD");
});

test("correo inválido devuelve EMAIL_INVALID", async () => {
  const res = await authService.signUpWithEmail({
    email: "no-es-un-correo",
    password: "hola1234",
    name: "Mal",
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "EMAIL_INVALID");
});

test("login con correo y contraseña correctos", async () => {
  const res = await authService.signInWithPassword({ identifier: SEED_EMAIL, password: SEED_PASSWORD });
  assert.equal(res.ok, true);
  const session = await authService.getSession();
  assert.equal(session.customer.email, SEED_EMAIL);
  assert.equal(session.customer.name, "Javier Castro");
});

test("login con teléfono (alias) y contraseña correctos", async () => {
  const res = await authService.signInWithPassword({ identifier: SEED_PHONE, password: SEED_PASSWORD });
  assert.equal(res.ok, true);
  const session = await authService.getSession();
  assert.equal(session.customer.email, SEED_EMAIL);
});

test("login con contraseña incorrecta devuelve INVALID_CREDENTIALS", async () => {
  const res = await authService.signInWithPassword({ identifier: SEED_EMAIL, password: "mala-contrasena" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "INVALID_CREDENTIALS");
});

test("email no registrado se reporta como INVALID_CREDENTIALS (anti-enumeración)", async () => {
  const res = await authService.signInWithPassword({ identifier: "nadie@nadie.example", password: "hola1234" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "INVALID_CREDENTIALS");
});

test("teléfono no registrado invita a usar el correo (ACCOUNT_NOT_FOUND)", async () => {
  const res = await authService.signInWithPassword({ identifier: "+52 610 000 0000", password: "hola1234" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "ACCOUNT_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// H1 — login por teléfono: normalización E.164 ANTES del RPC (modo real).
// phoneIdentifierForLogin es el helper del servicio REAL; el RPC solo
// compara por dígitos y el usuario escribe 10 dígitos frente a E.164 (+52).
// ---------------------------------------------------------------------------

test("H1: teléfono mexicano de 10 dígitos se normaliza a E.164", () => {
  assert.equal(phoneIdentifierForLogin("6641234567"), "+526641234567");
  assert.equal(phoneIdentifierForLogin("664 123 4567"), "+526641234567");
});

test("H1: teléfono ya en E.164 se conserva normalizado", () => {
  assert.equal(phoneIdentifierForLogin("+526641234567"), "+526641234567");
  assert.equal(phoneIdentifierForLogin("+52 664 123 4567"), "+526641234567");
});

test("H1: input no mexicano/inválido pasa tal cual; el RPC decide", () => {
  assert.equal(phoneIdentifierForLogin("abc"), "abc");
  assert.equal(phoneIdentifierForLogin(""), "");
  assert.equal(phoneIdentifierForLogin("123"), "123");
});

test("H1: login por teléfono de 10 dígitos (sin prefijo) es correcto", async () => {
  const res = await authService.signInWithPassword({ identifier: "6641234567", password: SEED_PASSWORD });
  assert.equal(res.ok, true);
  const session = await authService.getSession();
  assert.equal(session.customer.email, SEED_EMAIL);
});

test("H1: teléfono inexistente (10 dígitos) devuelve ACCOUNT_NOT_FOUND", async () => {
  const res = await authService.signInWithPassword({ identifier: "6100000000", password: SEED_PASSWORD });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "ACCOUNT_NOT_FOUND");
});

test("recuperación: cuenta desconocida devuelve ACCOUNT_NOT_FOUND", async () => {
  const res = await authService.forgotPasswordStart({ identifier: "nadie@nadie.example" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "ACCOUNT_NOT_FOUND");
});

test("recuperación: se envía código al correo y se enmascara el contacto", async () => {
  const res = await authService.forgotPasswordStart({ identifier: SEED_EMAIL });
  assert.equal(res.ok, true);
  assert.ok(res.maskedContact?.includes("@"), "debe devolver contacto enmascarado");
});

test("recuperación: código incorrecto vs vencido", async () => {
  await authService.forgotPasswordStart({ identifier: SEED_EMAIL });

  const wrong = await authService.forgotPasswordVerify({ code: "111222" });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, "OTP_INVALID");

  const expired = await authService.forgotPasswordVerify({ code: "000000" });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, "OTP_EXPIRED");
});

test("setNewPassword exige pasar por OTP primero", async () => {
  await authService.signOutClient();
  const res = await authService.setNewPassword({ newPassword: "nueva1234" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "OTP_INVALID");
});

test("recuperación completa: OTP válido → contraseña nueva → entra con ella", async () => {
  const email = uniqueEmail("recovery");
  await authService.signUpWithEmail({ email, password: "hola1234", name: "Recupera" });
  await authService.signOutClient();

  const start = await authService.forgotPasswordStart({ identifier: email });
  assert.equal(start.ok, true);

  const verify = await authService.forgotPasswordVerify({ code: "123456" });
  assert.equal(verify.ok, true);

  const setPw = await authService.setNewPassword({ newPassword: "nueva1234" });
  assert.equal(setPw.ok, true);

  const oldLogin = await authService.signInWithPassword({ identifier: email, password: "hola1234" });
  assert.equal(oldLogin.ok, false);

  const newLogin = await authService.signInWithPassword({ identifier: email, password: "nueva1234" });
  assert.equal(newLogin.ok, true);
});

test("checkSecondaryContact detecta teléfono en uso y deja libre uno nuevo", async () => {
  const inUse = await authService.checkSecondaryContact({ method: "phone", value: SEED_PHONE });
  assert.equal(inUse.ok, false);
  assert.equal(inUse.error.code, "PHONE_IN_USE");

  const free = await authService.checkSecondaryContact({ method: "phone", value: "+52 655 123 4567" });
  assert.equal(free.ok, true);
});

// ---------------------------------------------------------------------------
// H3 — checkSecondaryContact debe detectar el teléfono usado sin RLS abierta
// (modo real usa phone_is_registered vía RPC; demo espeja el mismo criterio).
// ---------------------------------------------------------------------------

test("H3: teléfono en uso se detecta también escrito en 10 dígitos", async () => {
  const res = await authService.checkSecondaryContact({ method: "phone", value: "6641234567" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "PHONE_IN_USE");
});

test("H3: checkSecondaryContact detecta email en uso", async () => {
  const res = await authService.checkSecondaryContact({ method: "email", value: SEED_EMAIL });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "EMAIL_ALREADY_EXISTS");
});

test("Google existente deja sesión y Google nuevo crea cuenta nativa", async () => {
  await authService.signOutClient();

  authService.devSetGoogleMode("existing");
  const existing = await authService.signInWithGoogle();
  assert.equal(existing.ok, true);
  assert.equal(existing.status, "existing");
  assert.ok((await authService.getSession())?.customer, "debe haber sesión tras Google existente");
  await authService.signOutClient();

  authService.devSetGoogleMode("new");
  const fresh = await authService.signInWithGoogle();
  assert.equal(fresh.ok, true);
  assert.equal(fresh.status, "new");
  assert.ok((await authService.getSession())?.customer, "debe haber sesión tras Google nuevo");
});

test("error temporal simulado se reporta como NETWORK_ERROR", async () => {
  authService.devSetForceTransientError();
  const res = await authService.signInWithPassword({ identifier: SEED_EMAIL, password: SEED_PASSWORD });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "NETWORK_ERROR");
});