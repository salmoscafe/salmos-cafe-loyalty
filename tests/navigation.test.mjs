// Suite de la resolución de navegación por pathname (sin router).
// La SPA decide la experiencia por la primera ruta de la URL:
//   /        → cliente
//   /Staff   → staff
//   /Admin   → admin
// Corre con: node --test tests/

import test from "node:test";
import assert from "node:assert/strict";

import { resolveAppMode, modePath, APP_MODES } from "../src/lib/navigation.js";

test("resolveAppMode: rutas base", () => {
  assert.equal(resolveAppMode("/"), "client");
  assert.equal(resolveAppMode("/Staff"), "staff");
  assert.equal(resolveAppMode("/Admin"), "admin");
});

test("resolveAppMode: es case-insensitive y tolera barra final", () => {
  assert.equal(resolveAppMode("/staff"), "staff");
  assert.equal(resolveAppMode("/admin"), "admin");
  assert.equal(resolveAppMode("/STAFF/"), "staff");
  assert.equal(resolveAppMode("/ADMIN/"), "admin");
});

test("resolveAppMode: tolera subrutas conservando la experiencia", () => {
  assert.equal(resolveAppMode("/Staff/inicio"), "staff");
  assert.equal(resolveAppMode("/Admin/clientes"), "admin");
  assert.equal(resolveAppMode("/staff/"), "staff");
});

test("resolveAppMode: cualquier ruta desconocida cae al cliente por defecto", () => {
  assert.equal(resolveAppMode("/x"), "client");
  assert.equal(resolveAppMode("/foo/bar"), "client");
  assert.equal(resolveAppMode(""), "client");
  assert.equal(resolveAppMode(undefined), "client");
});

test("modePath devuelve la URL canónica de cada experiencia", () => {
  assert.equal(modePath("client"), "/");
  assert.equal(modePath("staff"), "/Staff");
  assert.equal(modePath("admin"), "/Admin");
  assert.equal(modePath("cualquier-cosa"), "/");
});

test("APP_MODES lista las tres experiencias", () => {
  assert.deepEqual(APP_MODES, ["client", "staff", "admin"]);
});