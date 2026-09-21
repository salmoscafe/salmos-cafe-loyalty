// Suite del core puro para `claim_verify` (0017): Staff/Admin valida el
// OTP de una recompensa. Importa DIRECTAMENTE
// supabase/functions/_shared/loyaltyEngineCore.js (sin Deno, sin red).
//
// Cubre (spec 0017):
//   * validateClaimVerifyPayload: rewardId UUID + OTP exactamente 6
//     dígitos; customerId, actorId/actorRole prohibidos
//   * decideActorPolicy: staff/admin verifican; customer NO (403
//     CUSTOMER_CLAIM_VERIFY_NOT_ALLOWED); sin sesión 401
//   * helpers de formato del hash (isValidOtpHashFormat / extractOtpSalt)
//   * mapRpcError: hints de la lista blanca → código específico; hint
//     desconocido → RPC_REJECTED (nunca se reenvía un hint arbitrario)
//   * buildVerifyClaimArgs: firma EXACTA de verify_reward_claim
//   * escaneo de la migración 0017 + seguridad de la pepper
//
// La lógica de "reward sin claim verified no se puede canjear" vive en
// PostgreSQL (redeem_reward, 0017); se verifica con escaneo estático de
// la migración aquí y end-to-end en el E2E real.
//
// Corre con: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  LOYALTY_RPC_HINTS,
  OPERATIONS,
  OTP_CODE_RE,
  buildRpcArgs,
  buildVerifyClaimArgs,
  decideActorPolicy,
  extractOtpSalt,
  isValidOtpHashFormat,
  mapRpcError,
  validateOperation,
  validatePayload,
} from "../supabase/functions/_shared/loyaltyEngineCore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const PROFILE_CUSTOMER = { id: UUID_A, role: "customer", active: true };
const PROFILE_STAFF = { id: UUID_A, role: "staff", active: true };
const PROFILE_ADMIN = { id: UUID_A, role: "admin", active: true };
const PROFILE_STAFF_INACTIVE = { id: UUID_A, role: "staff", active: false };

function userWith(overrides = {}) {
  return { id: UUID_A, email: "a@example.com", ...overrides };
}

const VALID_OTP_HASH = `${"ab".repeat(16)}:${"cd".repeat(32)}`;

// ---------------------------------------------------------------
// validateOperation / OPERATIONS
// ---------------------------------------------------------------
test("claim_verify está incluido en OPERATIONS", () => {
  assert.ok(OPERATIONS.includes("claim_verify"), "OPERATIONS debe contener claim_verify");
});

test("validateOperation acepta claim_verify", () => {
  assert.equal(validateOperation("claim_verify").ok, true);
});

test("OTP_CODE_RE exige exactamente 6 dígitos", () => {
  for (const ok of ["000000", "123456", "999999"]) assert.equal(OTP_CODE_RE.test(ok), true, ok);
  for (const bad of ["12345", "1234567", "12345a", " 123456", "123456 ", "", "abcdef"]) {
    assert.equal(OTP_CODE_RE.test(bad), false, bad);
  }
});

// ---------------------------------------------------------------
// validateClaimVerifyPayload
// ---------------------------------------------------------------
test("validatePayload claim_verify válido devuelve { rewardId, otp }", () => {
  const res = validatePayload("claim_verify", { operation: "claim_verify", rewardId: UUID_B, otp: "042319" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { rewardId: UUID_B, otp: "042319" });
});

test("validateClaimVerifyPayload rechaza rewardId ausente / no-UUID", () => {
  for (const rewardId of [undefined, "", "   ", 42, null, {}, "no-es-uuid"]) {
    const res = validatePayload("claim_verify", { operation: "claim_verify", rewardId, otp: "123456" });
    assert.equal(res.ok, false, `rewardId=${JSON.stringify(rewardId)}`);
    assert.ok(["MISSING_REWARD_ID", "INVALID_UUID"].includes(res.error.code), res.error.code);
  }
});

test("validateClaimVerifyPayload rechaza OTP de 5 dígitos", () => {
  const res = validatePayload("claim_verify", { operation: "claim_verify", rewardId: UUID_B, otp: "12345" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "INVALID_OTP");
});

test("validateClaimVerifyPayload rechaza OTP de 7 dígitos", () => {
  const res = validatePayload("claim_verify", { operation: "claim_verify", rewardId: UUID_B, otp: "1234567" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "INVALID_OTP");
});

test("validateClaimVerifyPayload rechaza OTP no numérico / no-string / vacío", () => {
  for (const otp of ["12345a", "abcdef", "12 456", "", " ", "１２３４５６", 123456, null, undefined, {}]) {
    const res = validatePayload("claim_verify", { operation: "claim_verify", rewardId: UUID_B, otp });
    assert.equal(res.ok, false, `otp=${JSON.stringify(otp)}`);
    assert.equal(res.error.code, "INVALID_OTP");
  }
});

test("validateClaimVerifyPayload rechaza customerId en el payload", () => {
  const res = validatePayload("claim_verify", { operation: "claim_verify", rewardId: UUID_B, otp: "123456", customerId: UUID_A });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "CUSTOMER_ID_NOT_ALLOWED");
});

test("validatePayload claim_verify rechaza actorId/actorRole (autoridad solo de la sesión)", () => {
  for (const payload of [
    { operation: "claim_verify", rewardId: UUID_B, otp: "123456", actorId: UUID_A },
    { operation: "claim_verify", rewardId: UUID_B, otp: "123456", actorRole: "staff" },
  ]) {
    const res = validatePayload("claim_verify", payload);
    assert.equal(res.ok, false, JSON.stringify(payload));
    assert.equal(res.error.code, "ACTOR_FIELDS_NOT_ALLOWED");
  }
});

test("validateClaimVerifyPayload rechaza cuerpo no-objeto", () => {
  for (const body of [null, "hola", 42, []]) {
    const res = validatePayload("claim_verify", body);
    assert.equal(res.ok, false, `body=${JSON.stringify(body)}`);
    assert.equal(res.error.code, "INVALID_PAYLOAD");
  }
});

// ---------------------------------------------------------------
// decideActorPolicy — claim_verify es Staff/Admin
// ---------------------------------------------------------------
test("staff activo pasa la política de claim_verify", () => {
  const res = decideActorPolicy({ operation: "claim_verify", user: userWith(), profile: PROFILE_STAFF });
  assert.equal(res.allowed, true);
  assert.deepEqual(res.actor, { actorId: UUID_A, actorRole: "staff" });
});

test("admin activo pasa la política de claim_verify", () => {
  const res = decideActorPolicy({ operation: "claim_verify", user: userWith(), profile: PROFILE_ADMIN });
  assert.equal(res.allowed, true);
  assert.deepEqual(res.actor, { actorId: UUID_A, actorRole: "admin" });
});

test("customer NO puede verificar OTP (CUSTOMER_CLAIM_VERIFY_NOT_ALLOWED 403)", () => {
  const res = decideActorPolicy({ operation: "claim_verify", user: userWith(), profile: PROFILE_CUSTOMER });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "CUSTOMER_CLAIM_VERIFY_NOT_ALLOWED");
  assert.equal(res.error.status, 403);
});

test("staff inactivo NO puede verificar OTP", () => {
  const res = decideActorPolicy({ operation: "claim_verify", user: userWith(), profile: PROFILE_STAFF_INACTIVE });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "PROFILE_NOT_FOUND");
});

test("sin sesión → UNAUTHORIZED 401 para claim_verify", () => {
  for (const noUser of [undefined, null, {}]) {
    const res = decideActorPolicy({ operation: "claim_verify", user: noUser, profile: PROFILE_STAFF });
    assert.equal(res.allowed, false);
    assert.equal(res.error.code, "UNAUTHORIZED");
    assert.equal(res.error.status, 401);
  }
});

test("regresión: claim_start sigue siendo del customer y el staff sigue denegado", () => {
  const staffStart = decideActorPolicy({ operation: "claim_start", user: userWith(), profile: PROFILE_STAFF });
  assert.equal(staffStart.allowed, false);
  assert.equal(staffStart.error.code, "STAFF_CLAIM_START_NOT_ALLOWED");

  const customerStart = decideActorPolicy({ operation: "claim_start", user: userWith(), profile: PROFILE_CUSTOMER });
  assert.equal(customerStart.allowed, true);
});

// ---------------------------------------------------------------
// Formato del hash del OTP
// ---------------------------------------------------------------
test("isValidOtpHashFormat acepta saltHex32:hex64 y rechaza otros formatos", () => {
  assert.equal(isValidOtpHashFormat(VALID_OTP_HASH), true);
  for (const bad of [null, undefined, "", "abc", "ab".repeat(16), `${"ab".repeat(16)}:`, `${"ab".repeat(16)}:${"cd".repeat(31)}`, `${"zz".repeat(16)}:${"cd".repeat(32)}`]) {
    assert.equal(isValidOtpHashFormat(bad), false, JSON.stringify(bad));
  }
});

test("extractOtpSalt devuelve el salt embebido y null si el formato es inválido", () => {
  assert.equal(extractOtpSalt(VALID_OTP_HASH), "ab".repeat(16));
  assert.equal(extractOtpSalt("no-formato"), null);
  assert.equal(extractOtpSalt(null), null);
});

// ---------------------------------------------------------------
// mapRpcError — hints de la lista blanca (0017)
// ---------------------------------------------------------------
test("mapRpcError mapea cada hint de negocio a su propio código con 400", () => {
  for (const hint of LOYALTY_RPC_HINTS) {
    const mapped = mapRpcError({ code: "P0001", message: "msg de negocio", hint });
    assert.equal(mapped.code, hint, hint);
    assert.equal(mapped.status, 400, hint);
    assert.equal(mapped.message, "msg de negocio", hint);
  }
});

test("mapRpcError sin hint cae al RPC_REJECTED genérico", () => {
  const mapped = mapRpcError({ code: "P0001", message: "X" });
  assert.equal(mapped.code, "RPC_REJECTED");
  assert.equal(mapped.status, 400);
});

test("mapRpcError NUNCA reenvía un hint arbitrario/desconocido", () => {
  for (const hint of ["DROP TABLE", "SOMETHING_ELSE", "__proto__", "OTP_INVALID; DROP"]) {
    const mapped = mapRpcError({ code: "P0001", message: "X", hint });
    assert.equal(mapped.code, "RPC_REJECTED", hint);
    assert.equal(mapped.status, 400);
  }
});

test("mapRpcError mantiene los códigos existentes (42501/23505/429)", () => {
  assert.equal(mapRpcError({ code: "42501" }).code, "RPC_NOT_AUTHORIZED");
  assert.equal(mapRpcError({ code: "23505" }).code, "DUPLICATE");
  assert.equal(mapRpcError({ code: "429" }).code, "RATE_LIMITED");
  assert.equal(mapRpcError({}).code, "INTERNAL");
});

// ---------------------------------------------------------------
// buildVerifyClaimArgs — firma EXACTA de verify_reward_claim
// ---------------------------------------------------------------
const ACTOR = { actorId: "staff-1", actorRole: "staff" };

test("buildVerifyClaimArgs coincide con la firma verify_reward_claim(uuid,text,text,text)", () => {
  const args = buildVerifyClaimArgs({ rewardId: UUID_A, candidateHash: "hash-candidato" }, ACTOR);
  assert.deepEqual(args, {
    p_reward_id: UUID_A,
    p_candidate_hash: "hash-candidato",
    p_actor_id: "staff-1",
    p_actor_role: "staff",
  });
});

test("buildRpcArgs despacha claim_verify (sin enviar el OTP, solo el candidato)", () => {
  const args = buildRpcArgs("claim_verify", { rewardId: UUID_A, candidateHash: "cand" }, { actor: ACTOR });
  assert.equal(args.p_reward_id, UUID_A);
  assert.equal(args.p_candidate_hash, "cand");
  assert.equal(Object.hasOwn(args, "p_otp"), false, "el OTP en claro nunca va a la RPC");
  assert.equal(Object.hasOwn(args, "otp"), false);
});

// ---------------------------------------------------------------
// Escaneo estático de la migración 0017
// ---------------------------------------------------------------
const MIGRATION_0017 = readFileSync(
  join(REPO_ROOT, "supabase/migrations/0017_reward_claim_otp.sql"),
  "utf8"
);

test("0017 define verify_reward_claim y constant_time_equal", () => {
  assert.match(MIGRATION_0017, /create or replace function public\.verify_reward_claim\s*\(/i);
  assert.match(MIGRATION_0017, /create or replace function public\.constant_time_equal\s*\(/i);
});

test("0017 reemplaza redeem_reward exigiendo una claim 'verified'", () => {
  assert.match(MIGRATION_0017, /create or replace function public\.redeem_reward\s*\(/i);
  assert.match(MIGRATION_0017, /status\s*=\s*'verified'/i, "redeem_reward debe buscar una claim verified");
  assert.match(MIGRATION_0017, /REWARD_NOT_VERIFIED/, "sin claim verified debe rechazar con REWARD_NOT_VERIFIED");
  assert.match(MIGRATION_0017, /status\s*=\s*'redeemed'/i, "debe consumir la claim (verified → redeemed)");
});

test("0017 protege el índice UNIQUE de verified sin cancelar verificaciones previas", () => {
  assert.match(MIGRATION_0017, /CLAIM_ALREADY_VERIFIED/, "debe rechazar si ya existe otra verified");
  assert.match(MIGRATION_0017, /when unique_violation/i, "debe manejar el 23505 del índice parcial");
});

test("0017 usa hints dentro de la lista blanca del core", () => {
  const hints = [...MIGRATION_0017.matchAll(/hint\s*=\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(hints.length > 0, "0017 debe declarar hints de negocio");
  for (const hint of hints) {
    assert.ok(LOYALTY_RPC_HINTS.includes(hint), `hint ${hint} fuera de la lista blanca del core`);
  }
});

test("0017 NO contiene la pepper ni su valor (vive solo en la Edge)", () => {
  assert.equal(/LOYALTY_OTP_PEPPER/.test(MIGRATION_0017), false, "la pepper no debe aparecer en la migración");
});

test("la Edge usa verify_reward_claim y lee la pepper solo por Deno.env.get", () => {
  const edge = readFileSync(join(REPO_ROOT, "supabase/functions/loyalty-engine/index.ts"), "utf8");
  assert.ok(edge.includes("verify_reward_claim"), "la Edge debe invocar verify_reward_claim");
  assert.ok(edge.includes('Deno.env.get("LOYALTY_OTP_PEPPER")'), "la pepper se lee por Deno.env.get");
  assert.equal(/LOYALTY_OTP_PEPPER\s*[:=]\s*["'][^"']+["']/.test(edge), false, "sin valor hardcodeado");
});

test("el core no nombra la pepper (solo recibe `pepper` por parámetro)", () => {
  const core = readFileSync(join(REPO_ROOT, "supabase/functions/_shared/loyaltyEngineCore.js"), "utf8");
  assert.equal(core.includes("LOYALTY_OTP_PEPPER"), false);
});
