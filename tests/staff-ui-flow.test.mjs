// Suite CP3.2.1 — separación Compra vs. Recompensa en la UI de Staff.
// Verifica a nivel de fuente (patrón del repo) que:
//   * StaffHome NO ofrece ninguna acción de compra.
//   * "Asignar cliente al ticket" ya no existe.
//   * El escaneo de Salmos queda asociado a validación de recompensa.
//   * No existe flujo real Staff → Scanner → RegisterSale.
//   * RegisterSale sigue siendo demo/contingencia.
//   * No se rompe el flujo de lookup (scanCustomerToken intacto).
//
// Corre con: node --test "tests/*.test.mjs"

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const STAFF_HOME_SRC = join(REPO_ROOT, "src/screens/staff/StaffHome.jsx");
const SCANNER_SRC = join(REPO_ROOT, "src/screens/staff/Scanner.jsx");
const CUSTOMER_FOUND_SRC = join(REPO_ROOT, "src/screens/staff/CustomerFound.jsx");
const APP_SRC = join(REPO_ROOT, "src/App.jsx");

// ---------------------------------------------------------------
// StaffHome — no existe ninguna acción de compra
// ---------------------------------------------------------------
test("CP3.2.1: StaffHome ya no ofrece 'Asignar cliente al ticket'", () => {
  const src = readFileSync(STAFF_HOME_SRC, "utf8");
  assert.ok(!src.includes("Asignar cliente al ticket"),
    "no debe existir acción que sugiera asignar en el ticket desde Salmos");
});

test("CP3.2.1: StaffHome ya no presenta 'Escanear cliente' ni 'Registrar venta'", () => {
  const src = readFileSync(STAFF_HOME_SRC, "utf8");
  assert.ok(!src.includes("Escanear cliente"),
    "el escaneo no debe presentarse como acción de compra");
  assert.ok(!src.includes("Registrar venta"),
    "no debe existir tile de venta desde Salmos");
});

test("CP3.2.1: StaffHome presenta el escaneo como 'Validar recompensa'", () => {
  const src = readFileSync(STAFF_HOME_SRC, "utf8");
  assert.ok(src.includes("Validar recompensa"),
    "el tile principal debe llamarse Validar recompensa");
  assert.ok(src.includes("onScan"),
    "el tile de validación abre el Scanner (onScan)");
});

test("CP3.2.1: StaffHome aclara que las ventas se registran en Loyverse", () => {
  const src = readFileSync(STAFF_HOME_SRC, "utf8");
  assert.ok(src.includes("Las ventas se registran directamente en Loyverse."),
    "debe incluir la nota sobre ventas en Loyverse");
  assert.ok(src.includes("Salmos registra tu visita automáticamente después de la compra."),
    "debe incluir la nota sobre la visita automática por sync");
});

// ---------------------------------------------------------------
// No existe ruta real Staff → Scanner → Registrar compra
// ---------------------------------------------------------------
test("CP3.2.1: 'Registrar compra' en CustomerFound vive solo en la rama isDemo", () => {
  const found = readFileSync(CUSTOMER_FOUND_SRC, "utf8");
  const app = readFileSync(APP_SRC, "utf8");

  // El botón existe pero solo en demo
  const jsxBtn = "<PrimaryButton onClick={onRegisterSale}>Registrar compra</PrimaryButton>";
  assert.ok(found.includes(jsxBtn),
    "el botón demo de registro manual debe existir en CustomerFound");
  const before = found.slice(0, found.indexOf(jsxBtn));
  assert.ok(before.includes("{isDemo && ("),
    "Registrar compra debe estar protegido por isDemo");

  // App.jsx nunca lo ofrece como acción
  assert.ok(!app.includes("Registrar compra"),
    "App.jsx no debe sugerir registrar compra");
});

test("CP3.2.1: App.jsx no ofrece ninguna acción 'Asignar cliente al ticket'", () => {
  const app = readFileSync(APP_SRC, "utf8");
  assert.ok(!app.includes("Asignar cliente al ticket"),
    "App.jsx no debe contener la acción eliminada");
});

// ---------------------------------------------------------------
// Scanner queda como base de validación de recompensa
// ---------------------------------------------------------------
test("CP3.2.1: Scanner usa scanCustomerToken y no registra ventas", () => {
  const src = readFileSync(SCANNER_SRC, "utf8");
  assert.ok(src.includes("scanCustomerToken"),
    "el Scanner usa el lookup de token");
  assert.ok(!src.includes("registerSale"),
    "el Scanner no registra ventas");
});

// ---------------------------------------------------------------
// Lookup intacto (scanCustomerToken sigue funcionando)
// ---------------------------------------------------------------
test("CP3.2.1: CustomerFound no sugiere hand-off de compra al POS (solo validación)", () => {
  const src = readFileSync(CUSTOMER_FOUND_SRC, "utf8");
  assert.ok(src.includes("Validar recompensa") || src.includes("validar"),
    "los textos deben referirse a validación");
  assert.ok(!src.includes("Cobra en el POS"),
    "no debe incluir instrucciones de cobro (eso es tema del POS)");
  assert.ok(!src.includes("abre el ticket"),
    "no debe incluir instrucciones de ticket (POS asigna el cliente)");
});
