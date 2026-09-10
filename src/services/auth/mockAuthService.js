import { delay } from "../../lib/delay.js";
import {
  customers,
  authIdentities,
  cards,
  staffProfiles,
  generateId,
  logAudit,
} from "../../data/mockDatabase.js";

// ---------------------------------------------------------------
// authService (implementación MOCK) — simula sesión e identidad en
// memoria. Vive en `auth/` aparte del facade (`../authService.js`),
// que enruta a esta implementación cuando Supabase no está
// configurado (modo demo/dev). En producción real usa
// `./supabaseAuthService.js`.
//
// NOTA TÉCNICA: `identifyAccount` aquí es un lookup directo por
// simplicidad de mock. Supabase Auth NO expone "¿existe este
// correo?" como consulta directa (protección anti-enumeración) — en
// producción esa determinación se hace disparando
// signInWithOtp({shouldCreateUser:false}) y leyendo el resultado.
// ---------------------------------------------------------------

let session = { customerId: null };
let staffSession = { staffId: null };

// Verificación pendiente (identify → código enviado → verificar).
// Vive en memoria porque es un solo flujo a la vez en esta demo.
let pending = null;

// --- Flags SOLO para pruebas manuales en esta etapa mock. --------------
let devForceTransientErrorOnce = false;
let devGoogleModeOnce = null; // "existing" | "new" | null (auto)

export function devSetForceTransientError() {
  devForceTransientErrorOnce = true;
}
export function devSetGoogleMode(mode) {
  devGoogleModeOnce = mode;
}

function maybeFailTransiently() {
  if (devForceTransientErrorOnce) {
    devForceTransientErrorOnce = false;
    return true;
  }
  return false;
}

// -------------------------------------------------------------------

export async function getSession() {
  await delay(150);
  if (!session.customerId) return null;
  const customer = customers.find((c) => c.id === session.customerId) || null;
  return customer ? { customer } : null;
}

export async function signOutClient() {
  await delay(150);
  session = { customerId: null };
  return { ok: true };
}

export function onSessionChange() {
  return () => {};
}

export async function retryLoyverseSync() {
  await delay(150);
  return { ok: true, status: "skipped" };
}

function normalizePhone(value) {
  return value.replace(/\D/g, "");
}

function findIdentity(method, value) {
  if (method === "phone") {
    const target = normalizePhone(value);
    return authIdentities.find((i) => i.provider === "phone" && normalizePhone(i.providerId) === target);
  }
  const normalized = value.trim().toLowerCase();
  return authIdentities.find((i) => i.provider === method && i.providerId.toLowerCase() === normalized);
}

function maskContact(method, value) {
  if (method === "email") {
    const [user, domain] = value.split("@");
    if (!domain) return value;
    const visible = user.slice(0, 1);
    return `${visible}${"*".repeat(Math.max(user.length - 1, 2))}@${domain}`;
  }
  // teléfono: se muestran solo los últimos 2 dígitos.
  const digits = value.replace(/\D/g, "");
  return `••• •••${digits.slice(-2)}`;
}

// 1) identify — ¿esta cuenta ya existe?
export async function identifyAccount({ method, value }) {
  await delay(450);
  if (maybeFailTransiently()) return { ok: false, error: "transient" };

  const identity = findIdentity(method, value);
  return {
    ok: true,
    status: identity ? "existing" : "new",
    method,
    value,
    maskedContact: maskContact(method, value),
  };
}

// 2) requestCode — "envía" el código (mock: siempre 123456).
export async function requestCode({ method, value, forNewAccount }) {
  await delay(500);
  if (maybeFailTransiently()) return { ok: false, error: "transient" };

  const identity = findIdentity(method, value);
  pending = {
    mode: forNewAccount ? "new" : "existing",
    method,
    value,
    code: "123456",
    expiresAt: Date.now() + 5 * 60 * 1000,
    customerId: identity ? identity.customerId : null,
    verified: false,
  };
  return { ok: true, maskedContact: maskContact(method, value) };
}

// 3) verifyCode — valida el código de un solo uso.
// Convención de prueba (solo mock): "123456" siempre es válido,
// "000000" siempre simula un código vencido.
export async function verifyCode({ code }) {
  await delay(500);
  if (!pending) return { ok: false, error: "no_pending" };
  if (maybeFailTransiently()) return { ok: false, error: "transient" };

  if (code === "000000" || Date.now() > pending.expiresAt) {
    return { ok: false, error: "expired" };
  }
  if (code !== pending.code) {
    return { ok: false, error: "invalid" };
  }

  if (pending.mode === "existing") {
    session = { customerId: pending.customerId };
    logAudit({ actorId: pending.customerId, actorRole: "customer", action: "CUSTOMER_SIGNED_IN" });
    pending = null;
    return { ok: true, mode: "existing" };
  }

  // Nuevo usuario: solo marcamos el contacto como verificado.
  // La cuenta se crea en completeRegistration().
  pending.verified = true;
  return { ok: true, mode: "new" };
}

export async function resendCode() {
  if (!pending) return { ok: false, error: "no_pending" };
  return requestCode({ method: pending.method, value: pending.value, forNewAccount: pending.mode === "new" });
}

export function cancelPending() {
  pending = null;
}

// Revisa, ANTES de verificar código, si el contacto secundario
// (opcional) ya pertenece a otra cuenta.
export async function checkSecondaryContact({ method, value }) {
  await delay(350);
  if (!value) return { ok: true };
  const identity = findIdentity(method, value);
  if (identity) {
    return {
      ok: false,
      error: "conflict",
      message:
        method === "email"
          ? "Este correo ya está asociado a otra cuenta de Salmos."
          : "Este teléfono ya está asociado a otra cuenta de Salmos.",
    };
  }
  return { ok: true };
}

// 4) Google — mock sin OAuth real todavía.
export async function signInWithGoogle() {
  await delay(600);
  if (maybeFailTransiently()) return { ok: false, error: "transient" };

  const forcedNew = devGoogleModeOnce === "new";
  devGoogleModeOnce = null;

  if (!forcedNew) {
    const identity = authIdentities.find((i) => i.provider === "google");
    if (identity) {
      session = { customerId: identity.customerId };
      logAudit({ actorId: identity.customerId, actorRole: "customer", action: "CUSTOMER_SIGNED_IN" });
      return { ok: true, status: "existing" };
    }
  }

  return {
    ok: true,
    status: "new",
    googleProfile: { name: "Cliente Google", email: `cliente.google.${generateId("g")}@gmail.com` },
  };
}

// 5) completeRegistration — crea identidad + customer + card.
export async function completeRegistration({ name, secondaryContact, googleProfile }) {
  await delay(700);
  if (maybeFailTransiently()) return { ok: false, error: "transient" };

  let primaryMethod, primaryValue;
  if (googleProfile) {
    primaryMethod = "google";
    primaryValue = googleProfile.email;
  } else {
    if (!pending || !pending.verified) return { ok: false, error: "not_verified" };
    primaryMethod = pending.method;
    primaryValue = pending.value;
  }

  const customerId = generateId("cus");
  const cardId = generateId("card");
  const now = new Date().toISOString();

  customers.push({
    id: customerId,
    name: name || googleProfile?.name || "Cliente Salmos",
    email: primaryMethod === "email" ? primaryValue : googleProfile?.email || secondaryContact?.value || "",
    emailVerified: primaryMethod === "email" || Boolean(googleProfile),
    phone: primaryMethod === "phone" ? primaryValue : secondaryContact?.method === "phone" ? secondaryContact.value : "",
    createdAt: now,
  });

  authIdentities.push({ id: generateId("aid"), customerId, provider: primaryMethod, providerId: primaryValue });
  if (secondaryContact?.value) {
    authIdentities.push({
      id: generateId("aid"),
      customerId,
      provider: secondaryContact.method,
      providerId: secondaryContact.value,
    });
  }

  cards.push({ id: cardId, customerId, cardNumber: `SC-${String(100000 + customers.length).slice(-6)}`, status: "active" });

  logAudit({ actorId: customerId, actorRole: "customer", customerId, action: "ACCOUNT_CREATED" });

  session = { customerId };
  pending = null;
  return { ok: true };
}

// --- Staff -----------------------------------------------------------------

export async function getStaffSession() {
  await delay(150);
  if (!staffSession.staffId) return null;
  const staff = staffProfiles.find((s) => s.id === staffSession.staffId) || null;
  return staff ? { staff } : null;
}

export async function signInStaff({ pin }) {
  await delay(400);
  const staff = staffProfiles.find((s) => s.pin === pin && s.active);
  if (!staff) {
    return { ok: false, error: "PIN incorrecto o empleado inactivo." };
  }
  staffSession = { staffId: staff.id };
  logAudit({ actorId: staff.id, actorRole: staff.role, action: "STAFF_SIGNED_IN" });
  return { ok: true, staff };
}

export async function signOutStaff() {
  await delay(150);
  staffSession = { staffId: null };
  return { ok: true };
}