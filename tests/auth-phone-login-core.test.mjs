// ---------------------------------------------------------------
// auth-phone-login-core.test.mjs — lógica de la Edge auth-phone-login.
//
// GoTrue y la base se simulan con dobles en memoria: lo que se prueba
// es la POLÍTICA de la Edge (qué responde y qué nunca responde):
//   * el email jamás sale en la respuesta;
//   * teléfono inexistente ≡ contraseña incorrecta (sin enumeración);
//   * los intentos con teléfonos inexistentes también pasan por GoTrue
//     (consumen rate limit igual que los reales);
//   * piso de latencia para no filtrar existencia por tiempo.
// ---------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DECOY_EMAIL_DOMAIN,
  MIN_RESPONSE_MS,
  clientIpFrom,
  handlePhoneLogin,
  normalizePhoneForLogin,
  pickSessionTokens,
  validatePhoneLoginRequest,
} from "../supabase/functions/_shared/authPhoneLoginCore.js";
import { toE164Mx } from "../src/lib/phone.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ACCOUNT = { phone: "+526641234567", email: "javier.privado@example.com", password: "correcta123", otp: "123456" };

// Doble de "base + GoTrue". Registra cada llamada para poder afirmar
// que el camino del señuelo también consulta a GoTrue.
function makeDeps({ rateLimited = false, dbDown = false, unconfirmed = false } = {}) {
  const calls = { resolve: [], signIn: [], sendOtp: [], verify: [], sleeps: [] };
  let clock = 1_000;
  const goTrueError = (message, code, status) => ({ message, code, status });
  const deps = {
    async resolveEmail(phone) {
      calls.resolve.push(phone);
      if (dbDown) throw new Error("db down");
      return phone.replace(/\D/g, "") === ACCOUNT.phone.replace(/\D/g, "") ? ACCOUNT.email : null;
    },
    async signInWithPassword(email, password) {
      calls.signIn.push(email);
      clock += 30;
      if (rateLimited) return { session: null, error: goTrueError("Request rate limit reached", "over_request_rate_limit", 429) };
      if (email === ACCOUNT.email && password === ACCOUNT.password) {
        if (unconfirmed) return { session: null, error: goTrueError("Email not confirmed", "email_not_confirmed", 400) };
        return {
          session: {
            access_token: "at-123", refresh_token: "rt-456", expires_in: 3600, expires_at: 9999999999,
            token_type: "bearer", user: { id: "u1", email: ACCOUNT.email, phone: ACCOUNT.phone },
          },
          error: null,
        };
      }
      return { session: null, error: goTrueError("Invalid login credentials", "invalid_credentials", 400) };
    },
    async sendOtp(email) {
      calls.sendOtp.push(email);
      if (email === ACCOUNT.email) return { error: null };
      return { error: goTrueError("Signups not allowed for otp", "otp_disabled", 422) };
    },
    async verifyOtp(email, code) {
      calls.verify.push(email);
      if (rateLimited) return { session: null, error: goTrueError("rate limit", "over_request_rate_limit", 429) };
      if (email === ACCOUNT.email && code === ACCOUNT.otp) {
        return { session: { access_token: "at-r", refresh_token: "rt-r", user: { email: ACCOUNT.email } }, error: null };
      }
      return { session: null, error: goTrueError("Token has expired or is invalid", "otp_expired", 403) };
    },
    now: () => clock,
    async sleep(ms) {
      calls.sleeps.push(ms);
      clock += ms;
    },
    randomId: () => "rnd",
  };
  return { deps, calls };
}

const noEmailIn = (result) => {
  const text = JSON.stringify(result);
  assert.equal(text.includes("@"), false, `la respuesta no debe contener emails: ${text}`);
  assert.equal(text.includes(ACCOUNT.email), false);
};

// ---------------- Caso A — teléfono existente ----------------
test("Caso A: teléfono existente + contraseña correcta → sesión, sin email ni user", async () => {
  const { deps } = makeDeps();
  const r = await handlePhoneLogin({ operation: "password", phone: "664 123 4567", password: ACCOUNT.password }, deps);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(Object.keys(r.body.session).sort(), ["access_token", "expires_at", "expires_in", "refresh_token", "token_type"]);
  assert.equal(r.body.session.access_token, "at-123");
  assert.equal("user" in r.body.session, false);
  noEmailIn(r);
});

test("Caso A: recuperación con teléfono existente envía el OTP a SU correo y verifica → sesión sin email", async () => {
  const { deps, calls } = makeDeps();
  const start = await handlePhoneLogin({ operation: "recover_start", phone: "+52 664 123 4567" }, deps);
  assert.deepEqual(start, { status: 200, body: { ok: true } });
  assert.deepEqual(calls.sendOtp, [ACCOUNT.email]);
  const verify = await handlePhoneLogin({ operation: "recover_verify", phone: "+52 664 123 4567", code: ACCOUNT.otp }, deps);
  assert.equal(verify.status, 200);
  assert.equal(verify.body.session.access_token, "at-r");
  noEmailIn(verify);
});

test("Caso A: correo sin confirmar solo se informa a quien tiene la contraseña correcta", async () => {
  const { deps } = makeDeps({ unconfirmed: true });
  const ok = await handlePhoneLogin({ operation: "password", phone: ACCOUNT.phone, password: ACCOUNT.password }, deps);
  assert.equal(ok.status, 403);
  assert.equal(ok.body.code, "email_not_confirmed");
  const wrong = await handlePhoneLogin({ operation: "password", phone: ACCOUNT.phone, password: "otra-cosa" }, deps);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, "invalid_credentials");
  noEmailIn(ok);
});

// ---------------- Caso B — teléfono inexistente ----------------
test("Caso B: teléfono inexistente → mismo 401 genérico que contraseña incorrecta", async () => {
  const { deps } = makeDeps();
  const missing = await handlePhoneLogin({ operation: "password", phone: "6640000000", password: "loquesea1" }, deps);
  const wrongPw = await handlePhoneLogin({ operation: "password", phone: ACCOUNT.phone, password: "incorrecta" }, deps);
  assert.deepEqual(missing, wrongPw, "respuestas idénticas: no hay oráculo de existencia");
  assert.deepEqual(missing, { status: 401, body: { ok: false, code: "invalid_credentials", retriable: false } });
});

test("Caso B: recuperación con teléfono inexistente responde IGUAL que con uno existente", async () => {
  const { deps } = makeDeps();
  const missing = await handlePhoneLogin({ operation: "recover_start", phone: "6640000000" }, deps);
  const existing = await handlePhoneLogin({ operation: "recover_start", phone: ACCOUNT.phone }, deps);
  assert.deepEqual(missing, existing);
  const vMissing = await handlePhoneLogin({ operation: "recover_verify", phone: "6640000000", code: "123456" }, deps);
  const vWrong = await handlePhoneLogin({ operation: "recover_verify", phone: ACCOUNT.phone, code: "000000" }, deps);
  assert.deepEqual(vMissing, vWrong);
  assert.equal(vMissing.body.code, "otp_invalid");
});

// ---------------- Caso C — anon intentando descubrir el email ----------------
test("Caso C: ninguna operación devuelve el email (ni en éxito, error, rate limit o caída)", async () => {
  const scenarios = [makeDeps(), makeDeps({ rateLimited: true }), makeDeps({ dbDown: true }), makeDeps({ unconfirmed: true })];
  const bodies = [
    { operation: "password", phone: ACCOUNT.phone, password: ACCOUNT.password },
    { operation: "password", phone: ACCOUNT.phone, password: "mala" },
    { operation: "recover_start", phone: ACCOUNT.phone },
    { operation: "recover_verify", phone: ACCOUNT.phone, code: "111111" },
  ];
  for (const { deps } of scenarios) {
    for (const body of bodies) noEmailIn(await handlePhoneLogin(body, deps));
  }
});

test("Caso C: la Edge no acepta `email` ni identificadores con @ (no es un proxy de login genérico)", async () => {
  const { deps, calls } = makeDeps();
  for (const body of [
    { operation: "password", phone: ACCOUNT.email, password: "x" },
    { operation: "password", phone: ACCOUNT.phone, password: "x", email: ACCOUNT.email },
    { operation: "lookup", phone: ACCOUNT.phone },
    { operation: "recover_start", phone: ACCOUNT.phone, password: "x" },
    { operation: "recover_verify", phone: ACCOUNT.phone, code: "abc" },
    null,
    [],
  ]) {
    const r = await handlePhoneLogin(body, deps);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, "invalid_request");
  }
  assert.equal(calls.resolve.length, 0, "entradas inválidas ni siquiera consultan la base");
});

test("Caso C: piso de latencia — toda respuesta que depende de la cuenta tarda al menos MIN_RESPONSE_MS", async () => {
  for (const phone of [ACCOUNT.phone, "6640000000"]) {
    const { deps } = makeDeps();
    const t0 = deps.now();
    await handlePhoneLogin({ operation: "password", phone, password: "mala" }, deps);
    assert.ok(deps.now() - t0 >= MIN_RESPONSE_MS, `phone ${phone}`);
  }
});

// ---------------- Caso D — intentos repetidos con distintos teléfonos ----------------
test("Caso D: barrido de teléfonos → respuestas idénticas y cada intento pasa por GoTrue (rate limit por IP aplica)", async () => {
  const { deps, calls } = makeDeps();
  const phones = ["6640000001", "6640000002", ACCOUNT.phone, "6640000003", "6640000004"];
  const results = [];
  for (const phone of phones) {
    results.push(await handlePhoneLogin({ operation: "password", phone, password: "adivinanza1" }, deps));
  }
  for (const r of results) assert.deepEqual(r, results[0]);
  assert.equal(calls.signIn.length, phones.length, "un intento a GoTrue por cada request");
  const decoys = calls.signIn.filter((e) => e.endsWith(`@${DECOY_EMAIL_DOMAIN}`));
  assert.equal(decoys.length, phones.length - 1, "teléfonos sin cuenta usan el señuelo (nunca un email real ajeno)");
});

test("Caso D: cuando GoTrue limita (429) la respuesta es la misma exista o no la cuenta", async () => {
  const { deps } = makeDeps({ rateLimited: true });
  const a = await handlePhoneLogin({ operation: "password", phone: ACCOUNT.phone, password: ACCOUNT.password }, deps);
  const b = await handlePhoneLogin({ operation: "password", phone: "6640000000", password: ACCOUNT.password }, deps);
  assert.deepEqual(a, b);
  assert.equal(a.status, 429);
  assert.equal(a.body.code, "rate_limited");
});

// ---------------- Utilidades ----------------
test("normalizePhoneForLogin replica la regla del cliente (toE164Mx) para números de México", () => {
  for (const input of ["6641234567", "664 123 4567", "+52 664 123 4567", "52 6641234567", "(664) 123-4567"]) {
    assert.equal(normalizePhoneForLogin(input), toE164Mx(input), input);
  }
  assert.equal(normalizePhoneForLogin("12345"), null);
  assert.equal(normalizePhoneForLogin(""), null);
});

test("pickSessionTokens descarta `user` (que trae el email)", () => {
  const t = pickSessionTokens({ access_token: "a", refresh_token: "r", user: { email: "x@y.z" } });
  assert.equal(JSON.stringify(t).includes("@"), false);
  assert.equal(pickSessionTokens({ access_token: "a" }), null);
});

test("clientIpFrom toma la primera IP de x-forwarded-for y descarta basura", () => {
  const h = (v) => ({ get: (k) => (k === "x-forwarded-for" ? v : null) });
  assert.equal(clientIpFrom(h("201.141.10.5, 10.0.0.1")), "201.141.10.5");
  assert.equal(clientIpFrom(h("2806:2f0:9000::1")), "2806:2f0:9000::1");
  assert.equal(clientIpFrom(h("<script>")), null);
  assert.equal(clientIpFrom(h(null)), null);
});

test("validatePhoneLoginRequest acepta solo los campos previstos por operación", () => {
  assert.equal(validatePhoneLoginRequest({ operation: "password", phone: "6641234567", password: "x" }).ok, true);
  assert.equal(validatePhoneLoginRequest({ operation: "recover_verify", phone: "6641234567", code: "12345678" }).ok, true);
  assert.equal(validatePhoneLoginRequest({ operation: "password", phone: "6641234567", password: "x".repeat(257) }).ok, false);
});

// ---------------- Estático: la Edge solo responde lo que decide el core ----------------
test("la Edge auth-phone-login no construye respuestas con el email y lee la secret key solo por env", () => {
  const edge = readFileSync(join(REPO_ROOT, "supabase/functions/auth-phone-login/index.ts"), "utf8");
  assert.ok(edge.includes('Deno.env.get("SUPABASE_SECRET_KEYS")'));
  assert.ok(edge.includes("sb-forwarded-for"), "rate limit de Auth por IP real del cliente");
  assert.ok(edge.includes('rpc("resolve_email_for_login"'), "el lookup reutiliza la RPC (solo service_role)");
  assert.equal(/json\([^)]*email/.test(edge), false, "ninguna respuesta incluye email");
  assert.equal(/console\.(log|error|warn|info)/.test(edge), false, "sin logs que puedan filtrar email/contraseña");
  const config = readFileSync(join(REPO_ROOT, "supabase/config.toml"), "utf8");
  assert.match(config, /\[functions\.auth-phone-login\]\s*\nverify_jwt = false/);
});
