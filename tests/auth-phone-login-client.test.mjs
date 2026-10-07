// ---------------------------------------------------------------
// auth-phone-login-client.test.mjs — supabaseAuthService (modo real)
// con supabase-js simulado. Verifica que:
//   * login por TELÉFONO va a la Edge auth-phone-login y termina con
//     supabase.auth.setSession(tokens) — sesión Supabase normal;
//   * el navegador ya NO llama a la RPC resolve_email_for_login;
//   * login por EMAIL sigue el flujo existente (sin Edge);
//   * recuperación por teléfono no muestra ni recibe el email;
//   * el pre-chequeo de registro usa email_is_registered (booleano).
// ---------------------------------------------------------------
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const EDGE_URL = "https://example.test/functions/v1/auth-phone-login";
const state = { rpcCalls: [], setSessionCalls: [], signInCalls: [], otpCalls: [], verifyCalls: [], fetchCalls: [] };

mock.module("../src/lib/utils/env.js", {
  namedExports: {
    readEnv(key, fallback = "") {
      if (key === "VITE_AUTH_PHONE_LOGIN_FUNCTION_URL") return EDGE_URL;
      if (key === "VITE_SUPABASE_PUBLISHABLE_KEY") return "sb_publishable_test";
      return fallback;
    },
  },
});

mock.module("../src/lib/supabase/client.js", {
  namedExports: {
    isSupabaseConfigured: true,
    supabaseClient: {
      rpc: async (name, args) => {
        state.rpcCalls.push({ name, args });
        if (name === "email_is_registered") return { data: args.p_email === "ya@existe.mx", error: null };
        return { data: null, error: null };
      },
      auth: {
        setSession: async (tokens) => {
          state.setSessionCalls.push(tokens);
          return { data: { session: { ...tokens } }, error: null };
        },
        signInWithPassword: async (creds) => {
          state.signInCalls.push(creds);
          return creds.password === "correcta123" ? { error: null } : { error: { message: "Invalid login credentials" } };
        },
        signInWithOtp: async (args) => {
          state.otpCalls.push(args);
          return { error: null };
        },
        verifyOtp: async (args) => {
          state.verifyCalls.push(args);
          return { error: null };
        },
      },
    },
  },
});

const auth = await import("../src/services/auth/supabaseAuthService.js");

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    state.fetchCalls.push({ url, headers: options.headers, body });
    const { status, json } = handler(body);
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return () => {
    globalThis.fetch = original;
  };
}

beforeEach(() => {
  for (const key of Object.keys(state)) state[key] = [];
  auth.cancelPending();
});

const SESSION = { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, expires_at: 1, token_type: "bearer" };

test("login por teléfono: Edge → setSession; nunca RPC resolve_email_for_login", async () => {
  const restore = stubFetch(() => ({ status: 200, json: { ok: true, session: SESSION } }));
  try {
    const res = await auth.signInWithPassword({ identifier: "664 123 4567", password: "correcta123" });
    assert.deepEqual(res, { ok: true });
    assert.equal(state.fetchCalls.length, 1);
    assert.equal(state.fetchCalls[0].url, EDGE_URL);
    assert.deepEqual(state.fetchCalls[0].body, { operation: "password", phone: "+526641234567", password: "correcta123" });
    assert.deepEqual(state.setSessionCalls, [{ access_token: "at-1", refresh_token: "rt-1" }]);
    assert.equal(state.rpcCalls.length, 0, "el navegador ya no resuelve teléfono → email");
    assert.equal(state.signInCalls.length, 0, "no hay signInWithPassword del navegador con email ajeno");
  } finally {
    restore();
  }
});

test("login por teléfono: inexistente o contraseña mala → mismo error genérico, sin sesión", async () => {
  const restore = stubFetch(() => ({ status: 401, json: { ok: false, code: "invalid_credentials", retriable: false } }));
  try {
    const a = await auth.signInWithPassword({ identifier: "6640000000", password: "x1234567" });
    const b = await auth.signInWithPassword({ identifier: "6641234567", password: "mala12345" });
    assert.deepEqual(a, b);
    assert.equal(a.error.code, "PHONE_INVALID_CREDENTIALS");
    assert.equal(state.setSessionCalls.length, 0);
  } finally {
    restore();
  }
});

test("login por teléfono: 429 → RATE_LIMITED; red caída → NETWORK_ERROR", async () => {
  let restore = stubFetch(() => ({ status: 429, json: { ok: false, code: "rate_limited", retriable: true } }));
  try {
    const r = await auth.signInWithPassword({ identifier: "6641234567", password: "x1234567" });
    assert.equal(r.error.code, "RATE_LIMITED");
  } finally {
    restore();
  }
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  try {
    const r = await auth.signInWithPassword({ identifier: "6641234567", password: "x1234567" });
    assert.equal(r.error.code, "NETWORK_ERROR");
  } finally {
    globalThis.fetch = original;
  }
});

test("login por email: flujo existente (supabase.auth.signInWithPassword), sin Edge", async () => {
  const restore = stubFetch(() => {
    throw new Error("no debe llamarse la Edge");
  });
  try {
    const res = await auth.signInWithPassword({ identifier: "Javier@Example.com ", password: "correcta123" });
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(state.signInCalls, [{ email: "javier@example.com", password: "correcta123" }]);
    assert.equal(state.fetchCalls.length, 0);
    assert.equal(state.rpcCalls.length, 0);
  } finally {
    restore();
  }
});

test("recuperación por teléfono: texto genérico (sin email enmascarado) y verify → setSession", async () => {
  const restore = stubFetch((body) =>
    body.operation === "recover_start"
      ? { status: 200, json: { ok: true } }
      : { status: 200, json: { ok: true, session: SESSION } }
  );
  try {
    const start = await auth.forgotPasswordStart({ identifier: "664 123 4567" });
    assert.deepEqual(start, { ok: true, maskedContact: "registrado" });
    assert.equal(JSON.stringify(start).includes("@"), false);
    const verify = await auth.forgotPasswordVerify({ code: "123456" });
    assert.deepEqual(verify, { ok: true });
    assert.deepEqual(state.fetchCalls.map((c) => c.body), [
      { operation: "recover_start", phone: "+526641234567" },
      { operation: "recover_verify", phone: "+526641234567", code: "123456" },
    ]);
    assert.equal(state.setSessionCalls.length, 1);
    assert.equal(state.otpCalls.length + state.verifyCalls.length + state.rpcCalls.length, 0);
  } finally {
    restore();
  }
});

test("recuperación por teléfono: código incorrecto → OTP_INVALID", async () => {
  const restore = stubFetch((body) =>
    body.operation === "recover_start"
      ? { status: 200, json: { ok: true } }
      : { status: 401, json: { ok: false, code: "otp_invalid" } }
  );
  try {
    await auth.forgotPasswordStart({ identifier: "6641234567" });
    const verify = await auth.forgotPasswordVerify({ code: "000000" });
    assert.equal(verify.error.code, "OTP_INVALID");
    assert.equal(state.setSessionCalls.length, 0);
  } finally {
    restore();
  }
});

test("recuperación por email: flujo existente (signInWithOtp/verifyOtp directo)", async () => {
  const start = await auth.forgotPasswordStart({ identifier: "Javier@Example.com" });
  assert.equal(start.ok, true);
  assert.deepEqual(state.otpCalls, [{ email: "javier@example.com", options: { shouldCreateUser: false } }]);
  const verify = await auth.forgotPasswordVerify({ code: "123456" });
  assert.equal(verify.ok, true);
  assert.equal(state.verifyCalls[0].email, "javier@example.com");
});

test("registro: el pre-chequeo de correo usa email_is_registered (booleano)", async () => {
  const taken = await auth.checkSecondaryContact({ method: "email", value: "Ya@Existe.mx" });
  assert.equal(taken.error.code, "EMAIL_ALREADY_EXISTS");
  const free = await auth.checkSecondaryContact({ method: "email", value: "libre@nuevo.mx" });
  assert.deepEqual(free, { ok: true });
  assert.deepEqual(
    state.rpcCalls.map((c) => c.name),
    ["email_is_registered", "email_is_registered"]
  );
});
