// Suite del core puro para la operación `claim_start` — el CUSTOMER pide
// el OTP de su propia recompensa (redención OTP). Importa DIRECTAMENTE
// supabase/functions/_shared/loyaltyEngineCore.js (sin Deno, sin red).
//
// Cubre (spec OTP / claim_start):
//   * validateClaimStartPayload: rewardId requerido UUID; customerId,
//     actorId/actorRole prohibidos
//   * decideActorPolicy: customer activo SÍ pasa; staff/admin NUNCA
//     (el OTP lo solicita el dueño de la recompensa, jamás el staff en
//     nombre del cliente); el resto de operaciones siguen denegadas para
//     customer (regresión)
//   * OTP: 6 dígitos con crypto.getRandomValues, hash HMAC-SHA256 con
//     pepper + salt por claim + rewardId ligado, TTL +5 min
//   * buildClaimStartResponse: { ok, rewardId, otp, expiresAt } y NUNCA
//     otp_hash
//   * Seguridad: la pepper vive solo en el servidor (Deno.env.get) y el
//     core la recibe por parámetro; jamás en src/ ni con valor hardcodeado
//
// Corre con: node --test "tests/*.test.mjs"

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  OPERATIONS,
  OTP_LIFETIME_MINUTES,
  buildClaimStartResponse,
  decideActorPolicy,
  generateOtpCode,
  getOtpExpiry,
  hashOtp,
  randomSaltHex,
  validateOperation,
  validatePayload,
} from "../supabase/functions/_shared/loyaltyEngineCore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PEPPER = "pepper-de-prueba-solo-tests";

const PROFILE_CUSTOMER = { id: UUID_A, role: "customer", active: true };
const PROFILE_STAFF = { id: UUID_A, role: "staff", active: true };
const PROFILE_ADMIN = { id: UUID_A, role: "admin", active: true };
const PROFILE_CUSTOMER_INACTIVE = { id: UUID_A, role: "customer", active: false };

function userWith(overrides = {}) {
  return { id: UUID_A, email: "a@example.com", ...overrides };
}

// ---------------------------------------------------------------
// validateOperation — acepta claim_start
// ---------------------------------------------------------------
test("validateOperation acepta la operación claim_start", () => {
  assert.equal(validateOperation("claim_start").ok, true);
});

test("claim_start está incluido en OPERATIONS", () => {
  assert.ok(OPERATIONS.includes("claim_start"), "OPERATIONS debe contener claim_start");
});

// ---------------------------------------------------------------
// validateClaimStartPayload
// ---------------------------------------------------------------
test("validatePayload claim_start válido devuelve { rewardId }", () => {
  const res = validatePayload("claim_start", { operation: "claim_start", rewardId: UUID_B });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { rewardId: UUID_B });
});

test("validatePayload claim_start NO trima rewardId (mismo trato que redeem_reward)", () => {
  const res = validatePayload("claim_start", { operation: "claim_start", rewardId: `  ${UUID_B}  ` });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "INVALID_UUID");
});

test("validateClaimStartPayload rechaza customerId en el payload", () => {
  const res = validatePayload("claim_start", { operation: "claim_start", rewardId: UUID_B, customerId: UUID_A });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "CUSTOMER_ID_NOT_ALLOWED");
});

test("validateClaimStartPayload rechaza actorId/actorRole en el payload", () => {
  for (const payload of [
    { operation: "claim_start", rewardId: UUID_B, actorId: UUID_A },
    { operation: "claim_start", rewardId: UUID_B, actorRole: "customer" },
  ]) {
    const res = validatePayload("claim_start", payload);
    assert.equal(res.ok, false, JSON.stringify(payload));
    assert.equal(res.error.code, "ACTOR_FIELDS_NOT_ALLOWED");
  }
});

test("validateClaimStartPayload rechaza rewardId vacío / ausente", () => {
  for (const rewardId of [undefined, "", "   "]) {
    const res = validatePayload("claim_start", { operation: "claim_start", rewardId });
    assert.equal(res.ok, false, `rewardId=${JSON.stringify(rewardId)}`);
    assert.equal(res.error.code, "MISSING_REWARD_ID");
  }
});

test("validateClaimStartPayload rechaza rewardId string no-UUID", () => {
  const res = validatePayload("claim_start", { operation: "claim_start", rewardId: "no-es-uuid" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "INVALID_UUID");
});

test("validateClaimStartPayload rechaza rewardId no-string (MISSING, igual que redeem)", () => {
  for (const rewardId of [42, null, {}, true]) {
    const res = validatePayload("claim_start", { operation: "claim_start", rewardId });
    assert.equal(res.ok, false, `rewardId=${JSON.stringify(rewardId)}`);
    assert.equal(res.error.code, "MISSING_REWARD_ID");
  }
});

test("validateClaimStartPayload rechaza cuerpo no-objeto", () => {
  for (const body of [null, "hola", 42, []]) {
    const res = validatePayload("claim_start", body);
    assert.equal(res.ok, false, `body=${JSON.stringify(body)}`);
    assert.equal(res.error.code, "INVALID_PAYLOAD");
  }
});

// ---------------------------------------------------------------
// decideActorPolicy — claim_start es del CUSTOMER dueño
// ---------------------------------------------------------------
test("customer activo pasa la política de claim_start", () => {
  const res = decideActorPolicy({ operation: "claim_start", user: userWith(), profile: PROFILE_CUSTOMER });
  assert.equal(res.allowed, true);
  assert.equal(res.actor.actorId, UUID_A);
  assert.equal(res.actor.actorRole, "customer");
});

test("staff activo NO puede solicitar claim_start", () => {
  const res = decideActorPolicy({ operation: "claim_start", user: userWith(), profile: PROFILE_STAFF });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "STAFF_CLAIM_START_NOT_ALLOWED");
  assert.equal(res.error.status, 403);
});

test("admin activo NO puede solicitar claim_start", () => {
  const res = decideActorPolicy({ operation: "claim_start", user: userWith(), profile: PROFILE_ADMIN });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "STAFF_CLAIM_START_NOT_ALLOWED");
  assert.equal(res.error.status, 403);
});

test("customer inactivo NO pasa la política de claim_start", () => {
  const res = decideActorPolicy({ operation: "claim_start", user: userWith(), profile: PROFILE_CUSTOMER_INACTIVE });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "PROFILE_NOT_FOUND");
});

test("sin sesión → UNAUTHORIZED 401 para claim_start", () => {
  for (const noUser of [undefined, null, {}]) {
    const res = decideActorPolicy({ operation: "claim_start", user: noUser, profile: PROFILE_CUSTOMER });
    assert.equal(res.allowed, false);
    assert.equal(res.error.code, "UNAUTHORIZED");
    assert.equal(res.error.status, 401);
  }
});

test("regresión: customer sigue denegado para visit/cancel/redeem/lookup", () => {
  for (const op of ["visit", "cancel", "redeem", "lookup"]) {
    const res = decideActorPolicy({ operation: op, user: userWith(), profile: PROFILE_CUSTOMER });
    assert.equal(res.allowed, false, `op=${op} debe denegarse para customer`);
    assert.equal(res.error.status, 403);
  }
});

test("regresión: staff/admin siguen autorizados para visit/cancel/redeem", () => {
  for (const profile of [PROFILE_STAFF, PROFILE_ADMIN]) {
    for (const op of ["visit", "cancel", "redeem"]) {
      const res = decideActorPolicy({ operation: op, user: userWith(), profile });
      assert.equal(res.allowed, true, `op=${op} role=${profile.role} debe autorizarse`);
    }
  }
});

// ---------------------------------------------------------------
// generateOtpCode — 6 dígitos sin sesgo
// ---------------------------------------------------------------
test("generateOtpCode siempre devuelve 6 dígitos", () => {
  for (let i = 0; i < 100; i++) {
    assert.match(generateOtpCode(), /^\d{6}$/);
  }
});

test("generateOtpCode produce valores distintos entre llamadas", () => {
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    seen.add(generateOtpCode());
  }
  assert.ok(seen.size > 1, "25 llamadas deberían producir más de un valor");
});

// ---------------------------------------------------------------
// hashOtp — HMAC-SHA256(pepper, salt:otp:rewardId), salt embebido
// ---------------------------------------------------------------
test("hashOtp tiene formato saltHex:hex64 y embebe el salt", async () => {
  const salt = randomSaltHex();
  const hash = await hashOtp({ otp: "123456", rewardId: UUID_B, pepper: PEPPER, salt });
  const [saltPart, sigPart] = hash.split(":");
  assert.equal(saltPart, salt, "el salt debe estar embebido para poder verificar sin columna extra");
  assert.equal(sigPart.length, 64, "SHA-256 produce 64 hex chars");
  assert.match(sigPart, /^[0-9a-f]{64}$/);
});

test("hashOtp es determinista con el mismo salt/otp/rewardId", async () => {
  const opts = { otp: "654321", rewardId: UUID_B, pepper: PEPPER, salt: "00".repeat(16) };
  const h1 = await hashOtp(opts);
  const h2 = await hashOtp(opts);
  assert.equal(h1, h2);
});

test("hashOtp liga el OTP a su rewardId (otro reward → otro hash)", async () => {
  const base = { otp: "123456", pepper: PEPPER, salt: "11".repeat(16) };
  const hA = await hashOtp({ ...base, rewardId: UUID_A });
  const hB = await hashOtp({ ...base, rewardId: UUID_B });
  assert.notEqual(hA, hB, "un OTP de recompensa A no debe validar para la recompensa B");
});

test("hashOtp con salt distinto produce hash distinto", async () => {
  const base = { otp: "123456", rewardId: UUID_B, pepper: PEPPER };
  const h1 = await hashOtp({ ...base, salt: "aa".repeat(16) });
  const h2 = await hashOtp({ ...base, salt: "bb".repeat(16) });
  assert.notEqual(h1, h2);
});

test("hashOtp no expone el OTP ni la pepper en el hash", async () => {
  const otp = "482910";
  const hash = await hashOtp({ otp, rewardId: UUID_B, pepper: PEPPER });
  assert.ok(!hash.includes(otp), "el hash nunca debe contener el OTP en claro");
  assert.ok(!hash.includes(PEPPER), "el hash nunca debe contener la pepper");
});

test("TTL del OTP es 5 minutos (constante exportada)", () => {
  assert.equal(OTP_LIFETIME_MINUTES, 5);
});

test("getOtpExpiry devuelve now + 5 minutos con `now` inyectable", () => {
  const now = new Date("2026-09-17T12:00:00.000Z");
  const expiry = getOtpExpiry(now);
  assert.equal(expiry.toISOString(), "2026-09-17T12:05:00.000Z");
});

test("getOtpExpiry respeta la constante exportada (no hardcodea 5)", () => {
  const now = new Date("2026-09-17T12:00:00.000Z");
  const expiry = getOtpExpiry(now, OTP_LIFETIME_MINUTES);
  const minutes = (expiry.getTime() - now.getTime()) / 60000;
  assert.equal(minutes, OTP_LIFETIME_MINUTES);
});

// ---------------------------------------------------------------
// buildClaimStartResponse — contrato sin otp_hash
// ---------------------------------------------------------------
test("buildClaimStartResponse devuelve { ok, rewardId, otp, expiresAt } y NUNCA otp_hash", () => {
  const otp = "738241";
  const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
  const res = buildClaimStartResponse({ rewardId: UUID_B, otp, expiresAt });
  assert.deepEqual(Object.keys(res).sort(), ["expiresAt", "ok", "otp", "rewardId"]);
  assert.equal(res.ok, true);
  assert.equal(res.rewardId, UUID_B);
  assert.equal(res.otp, otp);
  assert.equal(res.expiresAt, expiresAt);
  const serialized = JSON.stringify(res);
  assert.ok(!serialized.includes("otp_hash"), "la respuesta nunca debe incluir otp_hash");
});

// ---------------------------------------------------------------
// Escaneo de seguridad — la pepper solo vive en el servidor
// ---------------------------------------------------------------
test("LOYALTY_OTP_PEPPER se lee solo por Deno.env.get (nunca hardcodeada)", () => {
  const edge = readFileSync(join(REPO_ROOT, "supabase/functions/loyalty-engine/index.ts"), "utf8");
  const readAsEnv = edge.includes('Deno.env.get("LOYALTY_OTP_PEPPER")');
  assert.equal(readAsEnv, true);
  assert.equal(/LOYALTY_OTP_PEPPER\s*[:=]\s*["'][^"']+["']/.test(edge), false);
});

test("el core de loyalty-engine recibe la pepper por parámetro (nunca la nombra)", () => {
  const core = readFileSync(join(REPO_ROOT, "supabase/functions/_shared/loyaltyEngineCore.js"), "utf8");
  assert.ok(!core.includes("LOYALTY_OTP_PEPPER"), "la pepper es un secreto de despliegue: el core solo usa el parámetro `pepper`");
});

test("LOYALTY_OTP_PEPPER no existe en src/ (jamás VITE_)", () => {
  const forbidden = "LOYALTY_OTP_PEPPER";
  const files = [];
  const scanDir = (dir, acc) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) scanDir(full, acc);
      else if (/\.(js|mjs|ts|tsx|jsx|html)$/.test(entry.name)) acc.push(full);
    }
    return acc;
  };
  scanDir(join(REPO_ROOT, "src"), files);
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    assert.ok(!content.includes(forbidden), `${forbidden} aparece en ${file} — jamás en el bundle del cliente.`);
  }
});

test("SUPABASE_SERVICE_ROLE_KEY no se filtra en src/ ni en el core (claim_start incluido)", () => {
  const forbidden = "SUPABASE_SERVICE_ROLE_KEY";
  const files = [];
  const scanDir = (dir, acc) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) scanDir(full, acc);
      else if (/\.(js|mjs|ts|tsx|jsx|html)$/.test(entry.name)) acc.push(full);
    }
    return acc;
  };
  files.push(...scanDir(join(REPO_ROOT, "src"), []));
  files.push(join(REPO_ROOT, "supabase/functions/_shared/loyaltyEngineCore.js"));
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    assert.ok(!content.includes(forbidden), `${forbidden} aparece en ${file}`);
  }
});