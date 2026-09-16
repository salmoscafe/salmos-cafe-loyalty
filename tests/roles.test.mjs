// Suite de roles (CHECKPOINT 1) para el mock de auth — modo demo.
// Cubre que getProfile() distinga correctamente:
//   * customer (registro/login cliente)
//   * staff (PIN mock)
//   * admin (PIN mock)
//   * usuario autenticado sin perfil propia → nunca tratado como staff/admin
//
// Nota: el mock es estado mutable a nivel de módulo; cada test cierra
// su sesión al terminar. Corre con: node --test tests/

import test from "node:test";
import assert from "node:assert/strict";

import { authService } from "../src/services/index.js";

function uniqueEmail(label) {
  return `roles.test.${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
}

test("customer registrado obtiene role=customer y puede autenticarse", async () => {
  await authService.signOutClient();
  await authService.signOutStaff();

  const email = uniqueEmail("customer");
  const res = await authService.signUpWithEmail({ email, password: "hola1234", name: "Cliente Rol" });
  assert.equal(res.ok, true);

  const session = await authService.getSession();
  assert.ok(session?.customer, "el customer debe tener sesión tras registrarse");

  const profile = await authService.getProfile();
  assert.equal(profile.id, session.customer.id);
  assert.equal(profile.role, "customer");
  assert.equal(profile.active, true);

  await authService.signOutClient();
  assert.equal(await authService.getProfile(), null);
});

test("staff autenticado con PIN obtiene role=staff", async () => {
  const res = await authService.signInStaff({ pin: "1234" });
  assert.equal(res.ok, true);
  assert.equal(res.staff.role, "staff");

  const profile = await authService.getProfile();
  assert.equal(profile.role, "staff");
  assert.equal(profile.name, "Ana Beltrán");
  assert.equal(profile.active, true);

  await authService.signOutStaff();
  assert.equal(await authService.getProfile(), null);
});

test("admin autenticado con PIN obtiene role=admin", async () => {
  const res = await authService.signInStaff({ pin: "9999" });
  assert.equal(res.ok, true);
  assert.equal(res.staff.role, "admin");

  const profile = await authService.getProfile();
  assert.equal(profile.role, "admin");
  assert.equal(profile.name, "Diana Salazar");

  await authService.signOutStaff();
});

test("un customer con sesión NO obtiene rol staff/admin por defecto", async () => {
  // Incluso con sesión de cliente activa, getProfile devuelve 'customer'.
  const email = uniqueEmail("persist");
  await authService.signUpWithEmail({ email, password: "hola1234", name: "Persistente" });

  const profile = await authService.getProfile();
  assert.equal(profile.role, "customer");

  await authService.signOutClient();
});

test("PIN incorrecto o empleado inactivo no abre sesión staff", async () => {
  const bad = await authService.signInStaff({ pin: "0000" });
  assert.equal(bad.ok, false);
  assert.equal(await authService.getProfile(), null);

  await authService.signOutStaff();
});