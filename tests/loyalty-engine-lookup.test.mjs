// Suite del core puro para la operación `lookup` (CHECKPOINT 3.1:
// Customer Lookup real). Importa DIRECTAMENTE
// supabase/functions/_shared/loyaltyEngineCore.js (sin Deno, sin red):
// el core es puro e importable desde Node.
//
// Cubre (spec CHECKPOINT 3.1):
//   * validateLookupPayload: token vacío / no-string / demasiado largo
//   * decideLookupPolicy: staff/admin pasan; customer / inactivo / sin
//     perfil / sin sesión quedan denegados con códigos específicos
//   * buildLookupResult: customer + cycle + progress + reward, incluyendo
//     progreso 0/7, 6/7, 7/7, ciclo null, recompensa expirada/redimida/null
//   * Seguridad: la respuesta nunca expone loyverse_customer_id, passwords,
//     tokens ni la service_role key
//
// Corre con: node --test "tests/*.test.mjs"

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  OPERATIONS,
  LOOKUP_TOKEN_MAX_LENGTH,
  buildLookupResult,
  decideLookupPolicy,
  errorOf,
  isValidUuid,
  validateLookupPayload,
  validateOperation,
  validatePayload,
} from "../supabase/functions/_shared/loyaltyEngineCore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

// ---------------------------------------------------------------
// validateOperation — acepta lookup
// ---------------------------------------------------------------
test("validateOperation acepta la operación lookup", () => {
  assert.equal(validateOperation("lookup").ok, true);
});

test("lookup está incluido en OPERATIONS", () => {
  assert.ok(OPERATIONS.includes("lookup"), "OPERATIONS debe contener lookup");
});

// ---------------------------------------------------------------
// validateLookupPayload
// ---------------------------------------------------------------
test("validatePayload lookup válido trima el token", () => {
  const res = validatePayload("lookup", { operation: "lookup", token: "  SC-S4MCJPMW  " });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { token: "SC-S4MCJPMW" });
});

test("validatePayload lookup acepta token de 12 caracteres (formato estándar)", () => {
  const res = validatePayload("lookup", { operation: "lookup", token: "SC-S4MCJPMW" });
  assert.equal(res.ok, true);
  assert.equal(res.data.token, "SC-S4MCJPMW");
});

test("validateLookupPayload rechaza token vacío", () => {
  const res = validatePayload("lookup", { operation: "lookup", token: "" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "INVALID_TOKEN");
});

test("validateLookupPayload rechaza token sin trim con solo espacios", () => {
  const res = validatePayload("lookup", { operation: "lookup", token: "   " });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "INVALID_TOKEN");
});

test("validateLookupPayload rechaza token no string", () => {
  for (const token of [42, null, undefined, true, {}]) {
    const res = validatePayload("lookup", { operation: "lookup", token });
    assert.equal(res.ok, false, `token=${JSON.stringify(token)} debería rechazarse`);
    assert.equal(res.error.code, "INVALID_TOKEN");
  }
});

test("validateLookupPayload rechaza token demasiado largo", () => {
  const longToken = "A".repeat(LOOKUP_TOKEN_MAX_LENGTH + 1);
  const res = validatePayload("lookup", { operation: "lookup", token: longToken });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "INVALID_TOKEN");
});

test("validateLookupPayload acepta token justo en el límite de longitud", () => {
  const maxToken = "A".repeat(LOOKUP_TOKEN_MAX_LENGTH);
  const res = validatePayload("lookup", { operation: "lookup", token: maxToken });
  assert.equal(res.ok, true);
  assert.equal(res.data.token, maxToken);
});

test("validateLookupPayload rechaza cuerpo no-objeto", () => {
  for (const body of [null, "hola", 42, []]) {
    const res = validatePayload("lookup", body);
    assert.equal(res.ok, false, `body=${JSON.stringify(body)} debería rechazarse`);
    assert.equal(res.error.code, "INVALID_PAYLOAD");
  }
});

// ---------------------------------------------------------------
// decideLookupPolicy — autorización server-side
// ---------------------------------------------------------------
const PROFILE_CUSTOMER = { id: UUID_A, role: "customer", active: true };
const PROFILE_STAFF = { id: UUID_A, role: "staff", active: true };
const PROFILE_ADMIN = { id: UUID_A, role: "admin", active: true };
const PROFILE_STAFF_INACTIVE = { id: UUID_A, role: "staff", active: false };

function userWith(overrides = {}) {
  return { id: UUID_A, email: "a@example.com", ...overrides };
}

test("staff activo pasa la política de lookup", () => {
  const res = decideLookupPolicy({ user: userWith(), profile: PROFILE_STAFF });
  assert.equal(res.allowed, true);
  assert.equal(res.actor.actorId, PROFILE_STAFF.id);
  assert.equal(res.actor.actorRole, "staff");
});

test("admin activo pasa la política de lookup", () => {
  const res = decideLookupPolicy({ user: userWith(), profile: PROFILE_ADMIN });
  assert.equal(res.allowed, true);
  assert.equal(res.actor.actorRole, "admin");
});

test("sin sesión (user undefined/null/empty) → UNAUTHORIZED 401", () => {
  for (const noUser of [undefined, null, {}]) {
    const res = decideLookupPolicy({ user: noUser, profile: PROFILE_STAFF });
    assert.equal(res.allowed, false);
    assert.equal(res.error.code, "UNAUTHORIZED");
    assert.equal(res.error.status, 401);
  }
});

test("sin perfil (null) → PROFILE_NOT_FOUND 403", () => {
  const res = decideLookupPolicy({ user: userWith(), profile: null });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "PROFILE_NOT_FOUND");
  assert.equal(res.error.status, 403);
});

test("perfil inactivo → PROFILE_INACTIVE 403", () => {
  const res = decideLookupPolicy({ user: userWith(), profile: PROFILE_STAFF_INACTIVE });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "PROFILE_INACTIVE");
  assert.equal(res.error.status, 403);
});

test("customer es rechazado → CUSTOMER_LOOKUP_NOT_ALLOWED 403", () => {
  const res = decideLookupPolicy({ user: userWith(), profile: PROFILE_CUSTOMER });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "CUSTOMER_LOOKUP_NOT_ALLOWED");
  assert.equal(res.error.status, 403);
});

test("rol inventado es rechazado (no es staff ni admin)", () => {
  const hacker = { id: UUID_A, role: "hacker", active: true };
  const res = decideLookupPolicy({ user: userWith(), profile: hacker });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "CUSTOMER_LOOKUP_NOT_ALLOWED");
});

test("user_metadata NO puede reemplazar el rol de profiles", () => {
  const res = decideLookupPolicy({
    user: userWith({ user_metadata: { role: "staff" }, app_metadata: { role: "admin" } }),
    profile: PROFILE_CUSTOMER,
  });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "CUSTOMER_LOOKUP_NOT_ALLOWED");
});

// ---------------------------------------------------------------
// buildLookupResult — respuesta pura del lookup
// ---------------------------------------------------------------
const MOCK_CUSTOMER = { id: UUID_A, name: "Javier Castro", customer_code: "SC-S4MCJPMW", loyverse_customer_id: "lv-abc" };
const MOCK_CYCLE = { id: UUID_B, cycle_number: 2, required_visits: 7, status: "active" };

test("buildLookupResult: progreso 0/7 → remaining 7, unlocked false", () => {
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: MOCK_CYCLE, activeVisits: 0, reward: null });
  assert.equal(result.customer.id, UUID_A);
  assert.equal(result.customer.name, "Javier Castro");
  assert.equal(result.customer.customer_code, "SC-S4MCJPMW");
  assert.equal(result.cycle.id, UUID_B);
  assert.equal(result.cycle.required_visits, 7);
  assert.equal(result.cycle.active, true);
  assert.equal(result.progress.visits, 0);
  assert.equal(result.progress.required, 7);
  assert.equal(result.progress.remaining, 7);
  assert.equal(result.progress.unlocked, false);
  assert.equal(result.reward, null);
});

test("buildLookupResult: progreso 6/7 → remaining 1, unlocked false", () => {
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: MOCK_CYCLE, activeVisits: 6, reward: null });
  assert.equal(result.progress.visits, 6);
  assert.equal(result.progress.remaining, 1);
  assert.equal(result.progress.unlocked, false);
});

test("buildLookupResult: progreso 7/7 → remaining 0, unlocked true", () => {
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: MOCK_CYCLE, activeVisits: 7, reward: null });
  assert.equal(result.progress.visits, 7);
  assert.equal(result.progress.remaining, 0);
  assert.equal(result.progress.unlocked, true);
});

test("buildLookupResult usa required de cycle.required_visits (nunca hardcodea 7)", () => {
  const customCycle = { id: UUID_B, cycle_number: 1, required_visits: 10, status: "active" };
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: customCycle, activeVisits: 5, reward: null });
  assert.equal(result.progress.required, 10);
  assert.equal(result.progress.remaining, 5);
  assert.equal(result.progress.unlocked, false);
});

test("buildLookupResult: remaining nunca es negativo (visitas > required)", () => {
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: MOCK_CYCLE, activeVisits: 10, reward: null });
  assert.equal(result.progress.remaining, 0);
  assert.equal(result.progress.unlocked, true);
});

test("buildLookupResult incluye reward cuando está disponible y no vencida", () => {
  const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const reward = { id: "rwd-1", status: "available", expires_at: futureDate, max_value: 150, label: "NO_DEBE_APARCER" };
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: MOCK_CYCLE, activeVisits: 7, reward });
  assert.equal(result.reward.id, "rwd-1");
  assert.equal(result.reward.status, "available");
  assert.equal(result.reward.expires_at, futureDate);
  assert.equal(result.reward.max_value, 150);
  assert.equal(result.reward.label, undefined, "label no debe salir en la respuesta del lookup");
});

test("buildLookupResult: reward vencida → null", () => {
  const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const reward = { id: "rwd-2", status: "available", expires_at: pastDate, max_value: 150 };
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: MOCK_CYCLE, activeVisits: 7, reward });
  assert.equal(result.reward, null);
});

test("buildLookupResult: reward redeemed → null", () => {
  const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const reward = { id: "rwd-3", status: "redeemed", expires_at: futureDate, max_value: 150 };
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: MOCK_CYCLE, activeVisits: 0, reward });
  assert.equal(result.reward, null);
});

test("buildLookupResult: reward cancelled → null", () => {
  const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const reward = { id: "rwd-4", status: "cancelled", expires_at: futureDate, max_value: 150 };
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: MOCK_CYCLE, activeVisits: 0, reward });
  assert.equal(result.reward, null);
});

test("buildLookupResult: sin cycle → cycle, progress y reward son null", () => {
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: null, activeVisits: 0, reward: null });
  assert.equal(result.customer.id, UUID_A);
  assert.equal(result.cycle, null);
  assert.equal(result.progress, null);
  assert.equal(result.reward, null);
});

test("buildLookupResult: customer null → customer null, todo lo demás null", () => {
  const result = buildLookupResult({ customer: null, cycle: null, activeVisits: 0, reward: null });
  assert.equal(result.customer, null);
  assert.equal(result.cycle, null);
  assert.equal(result.progress, null);
  assert.equal(result.reward, null);
});

// ---------------------------------------------------------------
// Contrato de la respuesta — nunca expone datos sensibles
// ---------------------------------------------------------------
test("buildLookupResult expone loyverse_mapped (booleano) pero nunca loyverse_customer_id", () => {
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: MOCK_CYCLE, activeVisits: 3, reward: null });
  // CP3.2: el booleano operativo SÍ se expone…
  assert.equal(result.customer.loyverse_mapped, true);
  // …pero el id real y su clave jamás llegan al cliente/app.
  assert.equal(result.customer.loyverse_customer_id, undefined);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("loyverse_customer_id"), "La clave loyverse_customer_id no debe aparecer");
  assert.ok(!serialized.includes("lv-abc"), "El valor real del id de Loyverse no debe aparecer");
});

// ---------------------------------------------------------------
// CP3.2 — loyverse_mapped: derivado del vínculo, nunca el id real
// ---------------------------------------------------------------
test("CP3.2: customer con loyverse_customer_id -> loyverse_mapped true", () => {
  const customer = { id: UUID_A, name: "Ana", customer_code: "SC-AAAA0001", loyverse_customer_id: "lv-linked" };
  const result = buildLookupResult({ customer, cycle: MOCK_CYCLE, activeVisits: 0, reward: null });
  assert.equal(result.customer.loyverse_mapped, true);
});

test("CP3.2: customer sin loyverse_customer_id -> loyverse_mapped false", () => {
  const customer = { id: UUID_A, name: "Ana", customer_code: "SC-AAAA0001" };
  const result = buildLookupResult({ customer, cycle: MOCK_CYCLE, activeVisits: 0, reward: null });
  assert.equal(result.customer.loyverse_mapped, false);
});

test("CP3.2: customer con loyverse_customer_id null -> loyverse_mapped false", () => {
  const customer = { id: UUID_A, name: "Ana", customer_code: "SC-AAAA0001", loyverse_customer_id: null };
  const result = buildLookupResult({ customer, cycle: MOCK_CYCLE, activeVisits: 0, reward: null });
  assert.equal(result.customer.loyverse_mapped, false);
});

test("CP3.2: el valor real de loyverse_customer_id nunca aparece en el response", () => {
  const secretId = "lv-super-secreto-123";
  const customer = { id: UUID_A, name: "Ana", customer_code: "SC-AAAA0001", loyverse_customer_id: secretId };
  const result = buildLookupResult({ customer, cycle: MOCK_CYCLE, activeVisits: 0, reward: null });
  assert.equal(result.customer.loyverse_mapped, true);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(secretId), "El id real no debe estar en el response serializado");
  assert.ok(!serialized.includes("loyverse_customer_id"), "La clave loyverse_customer_id no debe estar en el response");
});

test("buildLookupResult nunca expone passwords, tokens ni service_role key", () => {
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: MOCK_CYCLE, activeVisits: 3, reward: null });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.toLowerCase().includes("password"), "Sin passwords en la respuesta");
  assert.ok(!serialized.toLowerCase().includes("service_role"), "Sin service_role en la respuesta");
  assert.ok(!serialized.toLowerCase().includes("access_token"), "Sin access_token en la respuesta");
  assert.ok(!serialized.toLowerCase().includes("refresh_token"), "Sin refresh_token en la respuesta");
});

test("buildLookupResult no muta los objetos de entrada", () => {
  const customer = { id: UUID_A, name: "Test", customer_code: "SC-TEST0001", loyverse_customer_id: "lv-abc" };
  const cycle = { id: UUID_B, cycle_number: 1, required_visits: 7, status: "active" };
  const reward = { id: "rwd-x", status: "available", expires_at: new Date(Date.now() + 90 * 86400000).toISOString(), max_value: 100 };

  const customerSnapshot = { ...customer };
  const cycleSnapshot = { ...cycle };
  const rewardSnapshot = { ...reward };

  buildLookupResult({ customer, cycle, activeVisits: 3, reward });

  assert.deepEqual(customer, customerSnapshot, "customer no debe mutar");
  assert.deepEqual(cycle, cycleSnapshot, "cycle no debe mutar");
  assert.deepEqual(reward, rewardSnapshot, "reward no debe mutar");
});

// ---------------------------------------------------------------
// Contrato de las claves de la respuesta
// ---------------------------------------------------------------
test("buildLookupResult devuelve exactamente { customer, cycle, progress, reward }", () => {
  const futureDate = new Date(Date.now() + 90 * 86400000).toISOString();
  const reward = { id: "rwd-ok", status: "available", expires_at: futureDate, max_value: 150 };
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: MOCK_CYCLE, activeVisits: 4, reward });
  const keys = Object.keys(result).sort();
  assert.deepEqual(keys, ["customer", "cycle", "progress", "reward"]);
  assert.deepEqual(Object.keys(result.progress).sort(), ["remaining", "required", "unlocked", "visits"]);
  assert.deepEqual(Object.keys(result.customer).sort(), ["customer_code", "id", "loyverse_mapped", "name"]);
  assert.deepEqual(Object.keys(result.cycle).sort(), ["active", "cycle_number", "id", "required_visits"]);
  assert.deepEqual(Object.keys(result.reward).sort(), ["expires_at", "id", "max_value", "status"]);
});

test("buildLookupResult: sin cycle no tiene ni cycle ni progress ni reward", () => {
  const result = buildLookupResult({ customer: MOCK_CUSTOMER, cycle: null, activeVisits: 0, reward: null });
  assert.deepEqual(Object.keys(result).sort(), ["customer", "cycle", "progress", "reward"]);
  assert.equal(result.cycle, null);
  assert.equal(result.progress, null);
  assert.equal(result.reward, null);
});

// ---------------------------------------------------------------
// now inyectable — buildLookupResult usa el now que recibe
// ---------------------------------------------------------------
test("buildLookupResult con now explícito determina la expiración de la recompensa", () => {
  const futureDate = "2026-12-31T23:59:59Z";
  const reward = { id: "rwd-now", status: "available", expires_at: futureDate, max_value: 150 };

  // now antes de la expiración → reward visible
  const resultVisible = buildLookupResult({
    customer: MOCK_CUSTOMER,
    cycle: MOCK_CYCLE,
    activeVisits: 7,
    reward,
    now: new Date("2026-12-30T00:00:00Z"),
  });
  assert.equal(resultVisible.reward.id, "rwd-now");

  // now después de la expiración → reward null
  const resultExpired = buildLookupResult({
    customer: MOCK_CUSTOMER,
    cycle: MOCK_CYCLE,
    activeVisits: 7,
    reward,
    now: new Date("2027-01-01T00:00:00Z"),
  });
  assert.equal(resultExpired.reward, null);
});

// ---------------------------------------------------------------
// Escaneo de seguridad
// ---------------------------------------------------------------
test("SUPABASE_SERVICE_ROLE_KEY no se filtra en src/ ni en el core (lookup incluido)", () => {
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
    assert.ok(!content.includes(forbidden), `${forbidden} aparece en ${file} — prohibido en cliente/core.`);
  }
});

test("la Edge Function lee la service role key solo por Deno.env.get (lookup preservado)", () => {
  const edge = readFileSync(join(REPO_ROOT, "supabase/functions/loyalty-engine/index.ts"), "utf8");
  const readAsEnv = edge.includes('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")');
  assert.equal(readAsEnv, true);
  assert.equal(/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'][^"']+["']/.test(edge), false);
});

test("verify_jwt = true sigue configurado para loyalty-engine en config.toml", () => {
  const config = readFileSync(join(REPO_ROOT, "supabase/config.toml"), "utf8");
  const block = config.split("[functions.loyalty-engine]")[1]?.split(/\[functions\.|\n\[/)[0] || "";
  assert.match(block, /verify_jwt\s*=\s*true/);
});

test("loyaltyEngineCore.js no exporta nunca SUPABASE_SERVICE_ROLE_KEY", () => {
  const core = readFileSync(join(REPO_ROOT, "supabase/functions/_shared/loyaltyEngineCore.js"), "utf8");
  assert.ok(!core.includes("SUPABASE_SERVICE_ROLE_KEY"), "El core no debe mencionar la service role key");
});
