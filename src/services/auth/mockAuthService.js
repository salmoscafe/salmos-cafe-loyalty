import { delay } from "../../lib/delay.js";
import { phoneDigits, toE164Mx } from "../../lib/phone.js";
import {
  customers,
  authIdentities,
  cards,
  staffProfiles,
  generateId,
  logAudit,
} from "../../data/mockDatabase.js";
import { makeError } from "./authErrors.js";

// ---------------------------------------------------------------
// authService (implementación MOCK) — simula sesión e identidad en
// memoria. Vive en `auth/` aparte del facade (`../authService.js`),
// que enruta a esta implementación cuando Supabase no está
// configurado (modo demo/dev). En producción real usa
// `./supabaseAuthService.js`.
//
// Contrato IDÉNTICO al real (password como auth principal, OTP solo
// como recuperación). Con este mock puedes probar el flujo completo
// sin red:
//   * Cuentas de prueba: javier@example.com / maria.lopez@example.com
//     con contraseña "demo1234" (o su teléfono + demo1234).
//   * Registro nuevo: quedará con sesión inmediata (modo "complete").
//   * OTP de recuperación: "123456" siempre es válido,
//     "000000" simula un código vencido.
// ---------------------------------------------------------------

let session = { customerId: null };
let staffSession = { staffId: null };

// Recuperación de contraseña en curso.
let pending = null;

// "Base de datos" de credenciales del mock. Un customer tiene un email
// (su identificador de login) y opcionalmente un teléfono E.164.
// En el mock la contraseña vive en claro (no es un sistema real).
const accounts = [
  { customerId: "cus_1", email: "javier@example.com", password: "demo1234" },
  { customerId: "cus_2", email: "maria.lopez@example.com", password: "demo1234" },
];

const DEMO_OTP = "123456";
const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function customerPhone(customerId) {
  const customer = customers.find((c) => c.id === customerId);
  return customer?.phone ? toE164Mx(customer.phone) || customer.phone : null;
}

function findAccount(identifier) {
  const idn = String(identifier || "").trim();
  if (!idn) return null;
  if (idn.includes("@")) {
    return accounts.find((a) => a.email === idn.toLowerCase()) || null;
  }
  const targetDigits = toE164Mx(idn) ? phoneDigits(toE164Mx(idn)) : phoneDigits(idn);
  if (!targetDigits) return null;
  return accounts.find((a) => phoneDigits(customerPhone(a.customerId) || "") === targetDigits) || null;
}

function maskContact(method, value) {
  if (method === "email") {
    const [user, domain] = value.split("@");
    if (!domain) return value;
    const visible = user.slice(0, 1);
    return `${visible}${"*".repeat(Math.max(user.length - 1, 2))}@${domain}`;
  }
  const digits = value.replace(/\D/g, "");
  return `••• •••${digits.slice(-2)}`;
}

// -------------------------------------------------------------------
// Sesión.
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

export function cancelPending() {
  pending = null;
}

// -------------------------------------------------------------------
// Auth PRINCIPAL — email/teléfono + contraseña.
// -------------------------------------------------------------------

export async function signUpWithEmail({ email, password, name, phone }) {
  await delay(650);
  if (maybeFailTransiently()) return { ok: false, error: makeError("NETWORK_ERROR") };

  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) return { ok: false, error: makeError("EMAIL_INVALID") };
  if (!password || password.length < MIN_PASSWORD) return { ok: false, error: makeError("WEAK_PASSWORD") };

  if (accounts.some((a) => a.email === cleanEmail)) {
    return { ok: false, error: makeError("EMAIL_ALREADY_EXISTS") };
  }

  const phoneE164 = phone ? toE164Mx(phone) : null;
  if (phoneE164 && findAccount(phoneE164)) {
    return { ok: false, error: makeError("PHONE_IN_USE") };
  }

  const customerId = generateId("cus");
  const cardId = generateId("card");
  const now = new Date().toISOString();

  customers.push({
    id: customerId,
    name: String(name || "").trim() || "Cliente Salmos",
    email: cleanEmail,
    emailVerified: true,
    phone: phoneE164 || "",
    createdAt: now,
  });
  authIdentities.push({ id: generateId("aid"), customerId, provider: "email", providerId: cleanEmail });
  if (phoneE164) {
    authIdentities.push({ id: generateId("aid"), customerId, provider: "phone", providerId: phoneE164 });
  }
  cards.push({ id: cardId, customerId, cardNumber: `SC-${String(100000 + customers.length).slice(-6)}`, status: "active" });
  accounts.push({ customerId, email: cleanEmail, password });

  logAudit({ actorId: customerId, actorRole: "customer", customerId, action: "ACCOUNT_CREATED" });
  session = { customerId };
  return { ok: true, mode: "complete" };
}

export async function signInWithPassword({ identifier, password }) {
  await delay(500);
  if (maybeFailTransiently()) return { ok: false, error: makeError("NETWORK_ERROR") };

  const account = findAccount(identifier);
  if (!account) {
    // Espejamos al real: un email no registrado se reporta como credencial
    // inválida (anti-enumeración); un teléfono desconocido invita a usar correo.
    const isEmail = String(identifier || "").includes("@");
    return { ok: false, error: isEmail ? makeError("INVALID_CREDENTIALS") : makeError("ACCOUNT_NOT_FOUND") };
  }
  if (account.password !== password) return { ok: false, error: makeError("INVALID_CREDENTIALS") };

  session = { customerId: account.customerId };
  logAudit({ actorId: account.customerId, actorRole: "customer", action: "CUSTOMER_SIGNED_IN" });
  return { ok: true };
}

export async function checkSecondaryContact({ method, value }) {
  await delay(350);
  if (!value) return { ok: true };
  const account = findAccount(value);
  if (account) {
    return {
      ok: false,
      error: method === "email" ? makeError("EMAIL_ALREADY_EXISTS") : makeError("PHONE_IN_USE"),
    };
  }
  return { ok: true };
}

export async function resendConfirmationEmail() {
  await delay(200);
  return { ok: true };
}

// -------------------------------------------------------------------
// Recuperación de contraseña — OTP (simulado).
// -------------------------------------------------------------------

export async function forgotPasswordStart({ identifier }) {
  await delay(500);
  if (maybeFailTransiently()) return { ok: false, error: makeError("NETWORK_ERROR") };

  const account = findAccount(identifier);
  if (!account) return { ok: false, error: makeError("ACCOUNT_NOT_FOUND") };

  pending = {
    identifier,
    email: account.email,
    code: DEMO_OTP,
    expiresAt: Date.now() + 5 * 60 * 1000,
    verified: false,
  };
  return { ok: true, maskedContact: maskContact("email", account.email) };
}

export async function forgotPasswordVerify({ code }) {
  await delay(500);
  if (maybeFailTransiently()) return { ok: false, error: makeError("NETWORK_ERROR") };
  if (!pending) return { ok: false, error: makeError("OTP_INVALID") };

  if (code === "000000" || Date.now() > pending.expiresAt) {
    return { ok: false, error: makeError("OTP_EXPIRED") };
  }
  if (code !== pending.code) return { ok: false, error: makeError("OTP_INVALID") };

  pending.verified = true;
  return { ok: true };
}

export async function forgotPasswordResend() {
  await delay(400);
  if (!pending) return { ok: false };
  return forgotPasswordStart({ identifier: pending.identifier });
}

export async function setNewPassword({ newPassword }) {
  await delay(500);
  if (!pending || !pending.verified) return { ok: false, error: makeError("OTP_INVALID") };
  if (!newPassword || newPassword.length < MIN_PASSWORD) return { ok: false, error: makeError("WEAK_PASSWORD") };

  const account = accounts.find((a) => a.email === pending.email);
  if (account) account.password = newPassword;
  pending = null;
  return { ok: true };
}

// -------------------------------------------------------------------
// Google — simula el redirect → sesión ya resuelta.
// -------------------------------------------------------------------

export async function signInWithGoogle() {
  await delay(600);
  if (maybeFailTransiently()) return { ok: false, error: makeError("NETWORK_ERROR") };

  const forcedNew = devGoogleModeOnce === "new";
  devGoogleModeOnce = null;

  const identity = authIdentities.find((i) => i.provider === "google");
  if (identity && !forcedNew) {
    session = { customerId: identity.customerId };
    logAudit({ actorId: identity.customerId, actorRole: "customer", action: "CUSTOMER_SIGNED_IN" });
    return { ok: true, status: "existing" };
  }

  // Google "nuevo": crea la cuenta y deja la sesión lista (igual que el
  // proveedor real: el correo llega verificado por el propio Google).
  const email = `cliente.google.${generateId("g")}@gmail.com`;
  const customerId = generateId("cus");
  const cardId = generateId("card");
  const now = new Date().toISOString();

  customers.push({
    id: customerId,
    name: "Cliente Google",
    email,
    emailVerified: true,
    phone: "",
    createdAt: now,
  });
  authIdentities.push({ id: generateId("aid"), customerId, provider: "google", providerId: email });
  cards.push({ id: cardId, customerId, cardNumber: `SC-${String(100000 + customers.length).slice(-6)}`, status: "active" });
  accounts.push({ customerId, email, password: null });

  logAudit({ actorId: customerId, actorRole: "customer", customerId, action: "ACCOUNT_CREATED" });
  session = { customerId };
  return { ok: true, status: "new" };
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