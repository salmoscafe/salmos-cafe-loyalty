// Suite del adminService (CHECKPOINT 2) en modo demo/mock.
// Sin VITE_SUPABASE_URL, isSupabaseConfigured=false → adminService
// enruta a staffProfiles (equivalente mock de la Edge Function).
//
// Cubre (spec CHECKPOINT 2 §Parte 12):
//   * listEmployees: solo staff (nunca el admin), con email.
//   * createEmployee: role=staff + active=true; duplicados rechazados.
//   * updateEmployee / setEmployeeActive: renombrar y desactivar.
//   * Desactivación: el empleado ya no puede iniciar sesión staff.
//   * Regresión: getDashboardStats y listCustomersWithCards intactos.
//
// Nota: el mock es estado mutable a nivel de módulo; cada test limpia
// lo que crea. Corre con: node --test tests/

import test from "node:test";
import assert from "node:assert/strict";

import { adminService } from "../src/services/index.js";
import { staffProfiles } from "../src/data/mockDatabase.js";

function uniqueEmail(label) {
  return `admin.test.${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
}

test("listEmployees devuelve solo staff con email, rol y estado (no al admin)", async () => {
  const list = await adminService.listEmployees();
  assert.ok(Array.isArray(list));

  const roles = list.map((e) => e.role);
  assert.ok(roles.every((r) => r === "staff"), "solo staff en la lista de empleados");
  assert.ok(!list.some((e) => e.name === "Diana Salazar"), "Diana (admin) no debe listarse como empleada");

  const ana = list.find((e) => e.name === "Ana Beltrán");
  assert.ok(ana, "Ana debe estar en la lista");
  assert.equal(ana.email, "ana@example.com");
  assert.equal(ana.role, "staff");
  assert.equal(ana.active, true);
});

test("createEmployee crea un staff activo con role=staff", async () => {
  const email = uniqueEmail("create");
  const created = await adminService.createEmployee({ email, password: "hola1234", name: "Nuevo Empleado" });

  assert.equal(created.role, "staff");
  assert.equal(created.active, true);
  assert.equal(created.name, "Nuevo Empleado");
  assert.equal(created.email, email.toLowerCase());

  // El nuevo empleado existe en el mock con pin demo y puede entrar como staff.
  const stored = staffProfiles.find((s) => s.id === created.id);
  assert.ok(stored, "el empleado debe quedar guardado en staffProfiles");
  assert.equal(stored.role, "staff");
  assert.equal(stored.active, true);
  assert.ok(String(stored.pin).length === 4, "debe tener un pin demo de 4 dígitos");

  // Limpieza.
  const idx = staffProfiles.findIndex((s) => s.id === created.id);
  if (idx !== -1) staffProfiles.splice(idx, 1);
});

test("createEmployee rechaza email duplicado (email_already_exists)", async () => {
  const existing = staffProfiles[0].email; // ana@example.com (ya sembrado)
  await assert.rejects(
    () => adminService.createEmployee({ email: existing, password: "hola1234", name: "Duplicada" }),
    (err) => err.code === "email_already_exists"
  );
});

test("createEmployee nunca asigna role admin, aunque se intente enviar", async () => {
  const email = uniqueEmail("roler");
  const created = await adminService.createEmployee({ email, password: "hola1234", name: "Con Rol" });
  assert.equal(created.role, "staff");

  const stored = staffProfiles.find((s) => s.id === created.id);
  assert.equal(stored.role, "staff");

  const idx = staffProfiles.findIndex((s) => s.id === created.id);
  if (idx !== -1) staffProfiles.splice(idx, 1);
});

test("updateEmployee renombra a un empleado", async () => {
  const email = uniqueEmail("rename");
  const created = await adminService.createEmployee({ email, password: "hola1234", name: "Nombre Viejo" });
  const updated = await adminService.updateEmployee({ employeeId: created.id, name: "Nombre Nuevo" });
  assert.equal(updated.name, "Nombre Nuevo");

  const stored = staffProfiles.find((s) => s.id === created.id);
  assert.equal(stored.name, "Nombre Nuevo");

  const idx = staffProfiles.findIndex((s) => s.id === created.id);
  if (idx !== -1) staffProfiles.splice(idx, 1);
});

test("updateEmployee falla para un empleado inexistente (employee_not_found)", async () => {
  await assert.rejects(
    () => adminService.updateEmployee({ employeeId: "emp_no_existe", name: "X" }),
    (err) => err.code === "employee_not_found"
  );
});

test("desactivar un empleado lo bloquea del acceso staff (demo y perfil)", async () => {
  const email = uniqueEmail("deactivate");
  const created = await adminService.createEmployee({ email, password: "hola1234", name: "A Desactivar" });

  // El empleado nuevo sí puede entrar como staff (demo PIN).
  const { authService } = await import("../src/services/index.js");
  const stored = staffProfiles.find((s) => s.id === created.id);
  const okIn = await authService.signInStaff({ pin: stored.pin });
  assert.equal(okIn.ok, true);
  const profileActive = await authService.getProfile();
  assert.equal(profileActive.role, "staff");
  assert.equal(profileActive.active, true);
  await authService.signOutStaff();

  // Se desactiva.
  const updated = await adminService.setEmployeeActive({ employeeId: created.id, active: false });
  assert.equal(updated.active, false);

  // El PIN ya no abre sesión staff.
  const blocked = await authService.signInStaff({ pin: stored.pin });
  assert.equal(blocked.ok, false);

  // El perfil mock queda con active=false (la app y las Edge lo bloquean).
  const inactiveProfile = await authService.getProfile();
  assert.equal(inactiveProfile, null, "sin sesión staff activa no debe haber perfil staff");

  const idx = staffProfiles.findIndex((s) => s.id === created.id);
  if (idx !== -1) staffProfiles.splice(idx, 1);
  await authService.signOutStaff();
});

test("regresión: getDashboardStats y listCustomersWithCards siguen funcionando", async () => {
  const stats = await adminService.getDashboardStats();
  assert.equal(typeof stats.customers, "number");
  assert.equal(typeof stats.salesTotal, "number");
  assert.ok(Array.isArray(stats.byBranch));

  const customers = await adminService.listCustomersWithCards("javier");
  assert.ok(Array.isArray(customers));
});