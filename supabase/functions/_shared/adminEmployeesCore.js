// ---------------------------------------------------------------
// adminEmployeesCore — Lógica pura de la Edge Function
// `admin-employees` (CHECKPOINT 2: ADMIN → EMPLEADOS).
//
// Vive del lado servidor y es 100% agnóstico del transporte: NO toca
// Supabase, NO lee secrets, NO llama a la red ni a Loyverse, NO
// importa Deno. Por eso es unit-testable con `node --test` (ver
// tests/admin-employees-edge.test.mjs).
//
// Acciones expuestas por la Edge Function:
//   * create — crear un usuario Supabase Auth + perfil staff activo.
//   * list   — listar empleados (profiles con role='staff' + email).
//   * update — cambiar name y/o active de un empleado.
//
// Seguridad (obligatoria, CHECKPOINT 2 §Parte 10):
//   * La operación administrativa SOLO la ejecuta un usuario autenticado
//     cuyo perfil en public.profiles tiene role='admin' y active=true.
//     requireAdmin(profile) decide con el perfil server-side; NUNCA con
//     un role enviado desde el frontend ni con user_metadata.
//   * Al crear, el role SIEMPRE se fuerza a 'staff': si el cliente
//     envía role='admin' (o cualquier otro), se rechaza explícitamente.
//     Esta pantalla no puede crear administradores en V1.
//   * El payload no lleva actorId/actorRole: el actor se deriva de la
//     sesión (JWT) en la Edge.
// ---------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

// UUID 8-4-4-4-12 (cualquier versión, case-insensitive).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ADMIN_ACTIONS = Object.freeze(["create", "list", "update"]);

// Rol de los empleados creados desde esta pantalla. La UI solo ofrece
// "Staff"; el sistema conserva soporte para 'admin' en profiles, pero
// esta operación jamás lo asigna.
export const EMPLOYEE_ROLE = "staff";

// ---------------------------------------------------------------
// Errores controlados — forma única { code, message, status }.
// ---------------------------------------------------------------
export function errorOf(code, message, status = 400) {
  return { code, message, status };
}

export function isValidUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

// ---------------------------------------------------------------
// Acción
// ---------------------------------------------------------------
export function validateAction(value) {
  if (!ADMIN_ACTIONS.includes(value)) {
    return {
      ok: false,
      error: errorOf("INVALID_ACTION", "Acción no válida. Use create, list o update."),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------
// Política de administrador — resultado de la verificación server-side
// ---------------------------------------------------------------
// `profile` = { id, role, name, active } leído de public.profiles con
// service_role (la Edge lo resuelve a partir del user del JWT). Solo
// un admin activo pasa. Todo lo demás queda denegado con 403.
export function requireAdmin(profile) {
  if (!profile) {
    return {
      allowed: false,
      error: errorOf("PROFILE_NOT_FOUND", "No se pudo verificar tu perfil de acceso.", 403),
    };
  }
  if (profile.active === false) {
    return {
      allowed: false,
      error: errorOf("ADMIN_INACTIVE", "Tu cuenta de administración está desactivada.", 403),
    };
  }
  if (profile.role !== "admin") {
    return {
      allowed: false,
      error: errorOf("FORBIDDEN", "Se requieren privilegios de administrador.", 403),
    };
  }
  return { allowed: true, admin: profile };
}

// ---------------------------------------------------------------
// create → { email, password, name }
// ---------------------------------------------------------------
export function validateCreateEmployee(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: errorOf("INVALID_PAYLOAD", "El cuerpo debe ser un objeto JSON.") };
  }

  // NUNCA se confía en un role enviado desde el cliente. Si lo mandan
  // y no es 'staff' (en particular 'admin'), se rechaza explícitamente.
  const { email, password, name, role } = payload;
  if (role !== undefined && role !== EMPLOYEE_ROLE) {
    return {
      ok: false,
      error: errorOf("ROLE_NOT_ALLOWED", "Solo se pueden crear empleados con rol staff.", 403),
    };
  }

  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return { ok: false, error: errorOf("EMAIL_INVALID", "Escribe un correo válido.", 400) };
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    return {
      ok: false,
      error: errorOf("WEAK_PASSWORD", `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`, 400),
    };
  }
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, error: errorOf("NAME_REQUIRED", "El nombre es requerido.", 400) };
  }

  return {
    ok: true,
    data: {
      email: email.trim().toLowerCase(),
      password,
      name: name.trim(),
      role: EMPLOYEE_ROLE,
    },
  };
}

// ---------------------------------------------------------------
// update → { employeeId, name?, active? }
// ---------------------------------------------------------------
export function validateUpdateEmployee(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: errorOf("INVALID_PAYLOAD", "El cuerpo debe ser un objeto JSON.") };
  }

  const { employeeId, name, active } = payload;

  if (!isValidUuid(employeeId)) {
    return { ok: false, error: errorOf("INVALID_EMPLOYEE_ID", "Identificador de empleado inválido.", 400) };
  }

  if (name === undefined && active === undefined) {
    return { ok: false, error: errorOf("NOTHING_TO_UPDATE", "Envía al menos un campo a actualizar.", 400) };
  }

  const data = { employeeId };

  if (name !== undefined) {
    if (typeof name !== "string" || name.trim() === "") {
      return { ok: false, error: errorOf("NAME_REQUIRED", "El nombre no puede quedar vacío.", 400) };
    }
    data.name = name.trim();
  }

  if (active !== undefined) {
    if (typeof active !== "boolean") {
      return { ok: false, error: errorOf("INVALID_ACTIVE", "active debe ser true o false.", 400) };
    }
    data.active = active;
  }

  return { ok: true, data };
}

// ---------------------------------------------------------------
// Composición de la lista de empleados (profiles + emails de GoTrue)
// ---------------------------------------------------------------
// `profiles` = filas de public.profiles con role='staff'.
// `authUsers` = [{ id, email }] (Admin API). El email NO vive en
// profiles; se une por id. Si un perfil no tiene auth_user, el email
// queda vacío (nunca rompe la lista).
export function buildEmployeeList(profiles, authUsers) {
  const byId = new Map((authUsers || []).map((u) => [u.id, u]));
  return (profiles || [])
    .map((p) => ({
      id: p.id,
      name: p.name || "",
      email: byId.get(p.id)?.email || "",
      role: p.role,
      active: p.active !== false,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "es"));
}