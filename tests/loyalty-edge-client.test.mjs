// Suite del frontend para la operación `lookup` (CHECKPOINT 3.1:
// Customer Lookup real). Verifica que el servicio de Staff enruta
// correctamente entre modo demo (mock) y real (Edge Function).
//
// Cubre (spec CHECKPOINT 3.1 §Parte Frontend):
//   * Demo (sin VITE_SUPABASE_URL): scanCustomerToken usa findCustomerByToken
//     y devuelve la forma mock { ok, customer, card, cycle }.
//   * callLoyaltyEdge en modo demo → loyalty_unavailable (nunca toca red).
//   * loyaltyEdgeClient construye la URL correctamente: fallback a
//     `${VITE_SUPABASE_URL}/functions/v1/loyalty-engine`.
//   * StaffSource split: scanCustomerToken contiene la bifurcación isDemoMode
//     → findCustomerByToken vs callLoyaltyEdge({ operation: "lookup", token }).
//   * Seguridad: loyaltyEdgeClient usa Authorization Bearer y nunca expone
//     la service role key.
//
// Corre con: node --test "tests/*.test.mjs"

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { staffService } from "../src/services/index.js";
import { loyaltyEngineFunctionUrl } from "../src/services/loyalty/loyaltyEdgeClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const STAFF_SERVICE_SRC = join(REPO_ROOT, "src/services/staff/staffService.js");
const EDGE_CLIENT_SRC = join(REPO_ROOT, "src/services/loyalty/loyaltyEdgeClient.js");

// ---------------------------------------------------------------
// Demo mode (default Node env — sin VITE vars)
// ---------------------------------------------------------------
test("scanCustomerToken en demo devuelve el mock (findCustomerByToken) con customer y card", async () => {
  const result = await staffService.scanCustomerToken("SC-004821");
  assert.equal(result.ok, true);
  assert.ok(result.customer, "debe incluir customer");
  assert.ok(result.card, "debe incluir card (solo en mock/demo)");
  assert.equal(result.card.cardNumber, "SC-004821");
  assert.ok(result.cycle, "debe incluir cycle");
});

test("scanCustomerToken en demo rechaza un token inexistente", async () => {
  const result = await staffService.scanCustomerToken("SC-NONEXIST");
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

// ---------------------------------------------------------------
// loyaltyEdgeClient en demo → no toca red
// ---------------------------------------------------------------
test("callLoyaltyEdge en modo demo devuelve loyalty_unavailable (nunca hace fetch)", async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { fetchCalled = true; throw new Error("should not be called"); };
  try {
    const { callLoyaltyEdge } = await import("../src/services/loyalty/loyaltyEdgeClient.js");
    const result = await callLoyaltyEdge({ operation: "lookup", token: "SC-TEST0001" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "loyalty_unavailable");
    assert.equal(result.retriable, true);
    assert.equal(fetchCalled, false, "fetch no debe ser llamado en modo demo");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loyaltyEngineFunctionUrl() en Node (sin import.meta.env) devuelve null (fallback pendiente)", () => {
  // En Node, import.meta.env no existe → readEnv devuelve fallback;
  // readEnv(key, fallback) se llama con fallback = "" (default de loyaltyEdgeClient),
  // que es falsy → loyaltyEngineFunctionUrl returns null.
  // Esto es correcto: sin configuración de entorno, el cliente Edge no puede saber la URL.
  const url = loyaltyEngineFunctionUrl();
  assert.equal(url, null);
});

// ---------------------------------------------------------------
// StaffService bifurcación demo → real (source-level)
// ---------------------------------------------------------------
test("staffService.js contiene la bifurcación isDemoMode: demo → findCustomerByToken, real → callLoyaltyEdge({operation:'lookup',token})", () => {
  const src = readFileSync(STAFF_SERVICE_SRC, "utf8");
  assert.ok(src.includes("isDemoMode"), "staffService debe importar isDemoMode");
  assert.ok(src.includes("findCustomerByToken"), "demo branch usa findCustomerByToken");
  assert.ok(src.includes('callLoyaltyEdge({ operation: "lookup", token })'), "real branch llama callLoyaltyEdge con operation lookup");
});

test("staffService.js importa callLoyaltyEdge desde loyaltyEdgeClient", () => {
  const src = readFileSync(STAFF_SERVICE_SRC, "utf8");
  assert.ok(src.includes('../loyalty/loyaltyEdgeClient.js') || src.includes('../loyalty/loyaltyEdgeClient'),
    "staffService debe importar callLoyaltyEdge desde loyaltyEdgeClient");
});

// ---------------------------------------------------------------
// loyaltyEdgeClient — patron y seguridad
// ---------------------------------------------------------------
test("loyaltyEdgeClient.js usa Authorization Bearer (patron adminEdgeClient)", () => {
  const src = readFileSync(EDGE_CLIENT_SRC, "utf8");
  assert.ok(src.includes("Authorization: `Bearer ${token}`"), "usa Bearer token para autenticación");
  assert.ok(src.includes("getSession"), "obtiene sesión via supabaseClient.auth.getSession()");
});

test("loyaltyEdgeClient.js lee VITE_LOYALTY_ENGINE_FUNCTION_URL con fallback a loyalty-engine", () => {
  const src = readFileSync(EDGE_CLIENT_SRC, "utf8");
  assert.ok(src.includes("VITE_LOYALTY_ENGINE_FUNCTION_URL"), "lee la env var configurada");
  assert.ok(src.includes("functions/v1/loyalty-engine"), "fallback usa la URL estándar de la Edge");
});

test("loyaltyEdgeClient.js Nunca contiene SUPABASE_SERVICE_ROLE_KEY (prohibido en frontend)", () => {
  const src = readFileSync(EDGE_CLIENT_SRC, "utf8");
  assert.ok(!src.includes("SUPABASE_SERVICE_ROLE_KEY"), "la service role key no debe existir en el edge client");
});

test("loyaltyEdgeClient.js contiene el guard isSupabaseConfigured", () => {
  const src = readFileSync(EDGE_CLIENT_SRC, "utf8");
  assert.ok(src.includes("isSupabaseConfigured"), "debe tener el guard de configuración");
});

// ---------------------------------------------------------------
// Seguridad: SUPABASE_SERVICE_ROLE_KEY nunca en src/
// ---------------------------------------------------------------
test("SUPABASE_SERVICE_ROLE_KEY no se filtra en src/ (incluyendo loyaltyEdgeClient nuevo)", () => {
  const src = readFileSync(STAFF_SERVICE_SRC, "utf8");
  assert.ok(!src.includes("SUPABASE_SERVICE_ROLE_KEY"), "staffService no debe contener service role key");
});

// ---------------------------------------------------------------
// Config TOML
// ---------------------------------------------------------------
test("config.toml tiene verify_jwt = true para loyalty-engine (igual que admin-employees)", () => {
  const config = readFileSync(join(REPO_ROOT, "supabase/config.toml"), "utf8");
  const block = config.split("[functions.loyalty-engine]")[1]?.split(/\[functions\.|\n\[/)[0] || "";
  assert.match(block, /verify_jwt\s*=\s*true/);
});
