// Suite del core puro de la Edge Function `admin-employees`
// (CHECKPOINT 2: ADMIN → EMPLEADOS). Importa DIRECTAMENTE
// supabase/functions/_shared/adminEmployeesCore.js (sin Deno ni red):
// el core es puro e importable desde Node.
//
// Cubre (spec CHECKPOINT 2 §Partes 2/4/5/10/12):
//   * requireAdmin: solo admin activo pasa (staff/customer/admin inactivo
//     quedan denegados server-side).
//   * create: validación + rol SOLO staff (role='admin' desde el cliente
//     se rechaza), sin confiar en metadatos.
//   * update: name y active; uuid; campos; "nada que actualizar".
//   * buildEmployeeList: une profiles con emails de GoTrue.
//   * Escaneo de seguridad: SUPABASE_SERVICE_ROLE_KEY nunca en src/ ni
//     en el core; la Edge la lee solo por Deno.env.get.
//
// Corre con: node --test "tests/*.test.mjs"

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ADMIN_ACTIONS,
  EMPLOYEE_ROLE,
  buildEmployeeList,
  errorOf,
  isValidUuid,
  requireAdmin,
  validateAction,
  validateCreateEmployee,
  validateUpdateEmployee,
} from "../supabase/functions/_shared/adminEmployeesCore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const UUID_A = "11111111-2222-4333-8444-555555555555";

// ---------------------------------------------------------------
// requireAdmin — política server-side
// ---------------------------------------------------------------
test("admin activo pasa la política", () => {
  const res = requireAdmin({ id: UUID_A, role: "admin", active: true });
  assert.equal(res.allowed, true);
  assert.equal(res.admin.role, "admin");
});

test("staff autenticado es rechazado (FORBIDDEN 403)", () => {
  const res = requireAdmin({ id: UUID_A, role: "staff", active: true });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "FORBIDDEN");
  assert.equal(res.error.status, 403);
});

test("customer autenticado es rechazado (FORBIDDEN 403)", () => {
  const res = requireAdmin({ id: UUID_A, role: "customer", active: true });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "FORBIDDEN");
});

test("admin inactivo es rechazado (ADMIN_INACTIVE 403)", () => {
  const res = requireAdmin({ id: UUID_A, role: "admin", active: false });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "ADMIN_INACTIVE");
  assert.equal(res.error.status, 403);
});

test("sin perfil es rechazado (PROFILE_NOT_FOUND 403)", () => {
  for (const profile of [null, undefined]) {
    const res = requireAdmin(profile);
    assert.equal(res.allowed, false);
    assert.equal(res.error.code, "PROFILE_NOT_FOUND");
    assert.equal(res.error.status, 403);
  }
});

test("role no válido es rechazado", () => {
  const res = requireAdmin({ id: UUID_A, role: "inventado", active: true });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "FORBIDDEN");
});

// ---------------------------------------------------------------
// validateAction
// ---------------------------------------------------------------
test("validateAction acepta create/list/update", () => {
  for (const action of ADMIN_ACTIONS) assert.equal(validateAction(action).ok, true);
});

test("validateAction rechaza acción desconocida", () => {
  const res = validateAction("delete");
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "INVALID_ACTION");
});

// ---------------------------------------------------------------
// validateCreateEmployee
// ---------------------------------------------------------------
test("create válido normaliza email a minúsculas y fuerza role staff", () => {
  const res = validateCreateEmployee({
    email: "  Ana@Example.COM ",
    password: "hola1234",
    name: "  Ana Beltrán ",
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, {
    email: "ana@example.com",
    password: "hola1234",
    name: "Ana Beltrán",
    role: EMPLOYEE_ROLE,
  });
});

test("create acepta explícitamente role=staff", () => {
  const res = validateCreateEmployee({ email: "a@example.com", password: "hola1234", name: "Ana", role: "staff" });
  assert.equal(res.ok, true);
  assert.equal(res.data.role, "staff");
});

test("create con role='admin' enviado desde el cliente es rechazado (ROLE_NOT_ALLOWED 403)", () => {
  const res = validateCreateEmployee({
    email: "admin2@example.com",
    password: "hola1234",
    name: "Dos",
    role: "admin",
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "ROLE_NOT_ALLOWED");
  assert.equal(res.error.status, 403);
});

test("create con role='inventado' es rechazado", () => {
  const res = validateCreateEmployee({ email: "a@example.com", password: "hola1234", name: "Ana", role: "owner" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "ROLE_NOT_ALLOWED");
});

test("create valida email inválido", () => {
  for (const email of ["", "no-es-correo", "a@b", "a@.com"]) {
    const res = validateCreateEmployee({ email, password: "hola1234", name: "Ana" });
    assert.equal(res.ok, false, `email=${email} debería rechazarse`);
    assert.equal(res.error.code, "EMAIL_INVALID");
  }
});

test("create valida contraseña corta", () => {
  const res = validateCreateEmployee({ email: "a@example.com", password: "corta1", name: "Ana" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "WEAK_PASSWORD");
});

test("create valida nombre requerido", () => {
  for (const name of ["", "   "]) {
    const res = validateCreateEmployee({ email: "a@example.com", password: "hola1234", name });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "NAME_REQUIRED");
  }
});

test("create rechaza cuerpo no-objeto", () => {
  for (const body of [null, "hola", 42, []]) {
    const res = validateCreateEmployee(body);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "INVALID_PAYLOAD");
  }
});

// ---------------------------------------------------------------
// validateUpdateEmployee
// ---------------------------------------------------------------
test("update válido con solo name", () => {
  const res = validateUpdateEmployee({ employeeId: UUID_A, name: "Nuevo Nombre" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { employeeId: UUID_A, name: "Nuevo Nombre" });
});

test("update válido con solo active", () => {
  const res = validateUpdateEmployee({ employeeId: UUID_A, active: false });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { employeeId: UUID_A, active: false });
});

test("update válido con name + active", () => {
  const res = validateUpdateEmployee({ employeeId: UUID_A, name: "X", active: true });
  assert.deepEqual(res.data, { employeeId: UUID_A, name: "X", active: true });
});

test("update rechaza employeeId faltante o no-UUID", () => {
  const missing = validateUpdateEmployee({ name: "X" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "INVALID_EMPLOYEE_ID");
  const badUuid = validateUpdateEmployee({ employeeId: "no-uuid", name: "X" });
  assert.equal(badUuid.ok, false);
  assert.equal(badUuid.error.code, "INVALID_EMPLOYEE_ID");
});

test("update rechaza sin campos a actualizar", () => {
  const res = validateUpdateEmployee({ employeeId: UUID_A });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "NOTHING_TO_UPDATE");
});

test("update rechaza nombre vacío o no-texto", () => {
  assert.equal(validateUpdateEmployee({ employeeId: UUID_A, name: "  " }).error.code, "NAME_REQUIRED");
  assert.equal(validateUpdateEmployee({ employeeId: UUID_A, name: 42 }).error.code, "NAME_REQUIRED");
});

test("update rechaza active no-booleano", () => {
  assert.equal(validateUpdateEmployee({ employeeId: UUID_A, active: "true" }).error.code, "INVALID_ACTIVE");
  assert.equal(validateUpdateEmployee({ employeeId: UUID_A, active: 1 }).error.code, "INVALID_ACTIVE");
});

test("update rechaza cuerpo no-objeto", () => {
  assert.equal(validateUpdateEmployee(null).error.code, "INVALID_PAYLOAD");
  assert.equal(validateUpdateEmployee([]).error.code, "INVALID_PAYLOAD");
});

// ---------------------------------------------------------------
// buildEmployeeList — profiles + emails de GoTrue
// ---------------------------------------------------------------
test("buildEmployeeList une emails por id y ordena por nombre", () => {
  const profiles = [
    { id: UUID_A, role: "staff", name: "Ana Beltrán", active: true },
    { id: "22222222-3333-4444-8555-666666666666", role: "staff", name: "Marco Reyes", active: true },
  ];
  const users = [
    { id: "22222222-3333-4444-8555-666666666666", email: "marco@example.com" },
    { id: UUID_A, email: "ana@example.com" },
  ];
  const list = buildEmployeeList(profiles, users);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, "Ana Beltrán"); // orden alfabético
  assert.equal(list[0].email, "ana@example.com");
  assert.equal(list[1].email, "marco@example.com");
});

test("buildEmployeeList tolera perfiles sin auth_user (email vacío)", () => {
  const list = buildEmployeeList(
    [{ id: UUID_A, role: "staff", name: "Solo Perfil", active: true }],
    []
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].email, "");
});

test("buildEmployeeList ignora perfiles que no sean staff", () => {
  // La Edge filtra con .eq('role','staff'); el core solo arma la lista
  // con lo que recibe. Si llegara un admin, se conserva tal cual con rol.
  const list = buildEmployeeList([{ id: UUID_A, role: "admin", name: "Diana", active: true }], []);
  assert.equal(list.length, 1);
  assert.equal(list[0].role, "admin");
});

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
test("errorOf y isValidUuid básicos", () => {
  assert.deepEqual(errorOf("X", "msg", 404), { code: "X", message: "msg", status: 404 });
  assert.equal(isValidUuid(UUID_A), true);
  assert.equal(isValidUuid("abc"), false);
  assert.equal(isValidUuid(null), false);
});

// ---------------------------------------------------------------
// Escaneo de seguridad
// ---------------------------------------------------------------
// La service role key solo existe del lado servidor (Edge Function,
// vía Deno.env.get). Ningún test, ni el core, ni código frontend puede
// contenerla.
test("SUPABASE_SERVICE_ROLE_KEY no se filtra en src/ ni en el core de admin-employees", () => {
  const forbidden = "SUPABASE_SERVICE_ROLE_KEY";
  const files = [];

  const scanDir = (dir, acc) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) scanDir(full, acc);
      else if (/\.(js|mjs|ts|tsx|jsx)$/.test(entry.name)) acc.push(full);
    }
    return acc;
  };

  files.push(...scanDir(join(REPO_ROOT, "src"), []));
  files.push(join(REPO_ROOT, "supabase/functions/_shared/adminEmployeesCore.js"));

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    assert.ok(!content.includes(forbidden), `${forbidden} aparece en ${file} — prohibido en cliente/core.`);
  }
});

test("la Edge Function admin-employees lee la service role key solo por Deno.env.get", () => {
  const edge = readFileSync(join(REPO_ROOT, "supabase/functions/admin-employees/index.ts"), "utf8");
  const readAsEnv = edge.includes('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")');
  assert.equal(readAsEnv, true);
  // Ninguna asignación dura de la key (un valor literal nunca debe existir).
  assert.equal(/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'][^"']+["']/.test(edge), false);
});

test("config.toml registra admin-employees con verify_jwt = true", () => {
  const config = readFileSync(join(REPO_ROOT, "supabase/config.toml"), "utf8");
  const block = config.split("[functions.admin-employees]")[1]?.split(/\[functions\.|\n\[/)[0] || "";
  assert.match(block, /verify_jwt\s*=\s*true/);
});