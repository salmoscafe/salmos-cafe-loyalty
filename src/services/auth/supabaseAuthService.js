// ---------------------------------------------------------------
// authService (implementación REAL) — Supabase Auth + customers.
//
// Contrato (idéntico al mock, ver authService.js facade):
//   * signUpWithEmail / signInWithPassword  ← auth PRINCIPAL por contraseña
//   * forgotPassword* / setNewPassword      ← OTP SOLO como recuperación
//   * signInWithGoogle                      ← OAuth
//   * checkSecondaryContact / resendConfirmationEmail / sesión (getSession…)
//
// Cómo funciona cada pieza sobre Supabase:
//   * signInWithPassword acepta email O teléfono como identificador.
//       - email   → supabase.auth.signInWithPassword (flujo de siempre).
//       - teléfono → Edge `auth-phone-login`: el servidor resuelve el
//         teléfono a la cuenta y GoTrue valida la contraseña; al
//         navegador solo vuelven los tokens de sesión (setSession) o un
//         error genérico. El email de la cuenta NUNCA llega al navegador
//         (0020: resolve_email_for_login ya no es pública).
//   * forgotPasswordStart envía un código al correo (un solo de uso):
//       - email   → signInWithOtp({shouldCreateUser:false}) directo.
//       - teléfono → Edge `auth-phone-login` (recover_start/verify): la
//         respuesta es idéntica exista o no la cuenta.
//     No hay proveedor SMS configurado: el código siempre va al correo.
//   * verifyOtp (forgotPasswordVerify) crea una sesión efímera que
//     setNewPassword aprovecha para actualizar la contraseña con
//     updateUser. No quedan sesiones "tocadas por magia" después: la
//     recuperación termina y el usuario vuelve a entrar con su contraseña.
//   * Cada alta de sesión asegura el perfil `customers` (idempotente,
//     customer_code único) y dispara la vinculación Loyverse a través de
//     la Edge Function segura — nunca directo. Si falla, la sesión igual
//     se entrega y SyncBanner ofrece reintentar.
// ---------------------------------------------------------------

import { supabaseClient } from "../../lib/supabase/client.js";
import { generateCustomerCode } from "../../lib/customerCode.js";
import { toE164Mx } from "../../lib/phone.js";
import { ensureLoyaltyProfile } from "../customers/customerService.js";
import { createOrLinkLoyverseCustomer } from "../loyverse/loyverseCustomerService.js";
import { makeError, toFriendlyError } from "./authErrors.js";
import { callPhoneLogin } from "./phoneLoginEdgeClient.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

// Contexto de recuperación en curso (email dest). La verificación del
// código la maneja Supabase; aquí solo guardamos adónde se envió.
let pending = null;

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

function isEmailIdentifier(identifier) {
  return String(identifier || "").includes("@");
}

// Mapea la respuesta de la Edge auth-phone-login a errores amigables.
// Teléfono inexistente y contraseña incorrecta llegan con el MISMO
// código (invalid_credentials): la UI no puede distinguirlos.
function phoneLoginError(code, fallback) {
  if (code === "rate_limited") return makeError("RATE_LIMITED");
  if (code === "network_error" || code === "service_unavailable") return makeError("NETWORK_ERROR");
  return makeError(fallback);
}

// Instala en supabase-js la sesión emitida por GoTrue (vía la Edge).
// A partir de aquí la app se comporta igual que con login por email:
// onAuthStateChange(SIGNED_IN), getSession/getUser, refresh y RLS.
async function adoptSession(tokens) {
  if (!tokens?.access_token || !tokens?.refresh_token) return { ok: false, error: makeError("NETWORK_ERROR") };
  const { error } = await supabaseClient.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  if (error) return { ok: false, error: makeError("NETWORK_ERROR") };
  return { ok: true };
}

// Normaliza el teléfono a E.164 (+52) ANTES de mandarlo a la Edge
// auth-phone-login, porque en `customers` se almacena E.164 y el usuario
// escribe normalmente 10 dígitos. Si no se puede deducir un teléfono
// mexicano válido se pasa el texto tal cual: el servidor lo normaliza
// con la misma regla y compara por dígitos.
export function phoneIdentifierForLogin(identifier) {
  return toE164Mx(identifier) || identifier;
}

// ---------------------------------------------------------------------------
// Perfil `customers` (Supabase). La fila real del cliente de Salmos.
// ---------------------------------------------------------------------------

async function uniqueCustomerCode() {
  for (let i = 0; i < 6; i++) {
    const candidate = generateCustomerCode();
    const { data: clash } = await supabaseClient
      .from("customers")
      .select("id")
      .eq("customer_code", candidate)
      .maybeSingle();
    if (!clash) return candidate;
  }
  throw new Error("customer_code_unavailable");
}

// Crea la fila real si no existe (idempotente). Nunca crea un segundo
// perfil para el mismo auth_user_id (índice único en la BD).
//
// Teléfono (fuente oficial: customers.phone, formato E.164 MX):
//   * Se fija SOLO al crear la fila. Si ya existe, se devuelve tal cual:
//     la metadata nunca se vuelve a leer ni sobrescribe customers.phone.
//   * Origen al crear: parámetro explícito `phone`, o el transporte del
//     registro `user.user_metadata.phone` (signUpWithEmail lo guarda
//     ahí porque la fila aún no existe). auth.users.phone (GoTrue) NO se
//     usa: sin proveedor SMS no es una fuente válida.
//   * Solo se persiste si normaliza a E.164 MX (toE164Mx); si no, null.
//   * Conflicto de unicidad del teléfono (customers_phone_unique_key):
//     el número ya pertenece a OTRO cliente. No se toca a ese cliente ni
//     se toma el número: la fila se crea sin teléfono (la sesión sigue) y
//     el perfil devuelto lleva `phoneConflict: true` para que la UI/soporte
//     lo vean. El caso queda además detectable en la base (metadata con
//     teléfono + customers.phone null → pre-chequeo/backfill auditado).
export const PHONE_UNIQUE_CONSTRAINT = "customers_phone_unique_key";

export function initialProfilePhone(user, phone) {
  if (phone) return toE164Mx(phone) || null;
  const metaPhone = user?.user_metadata?.phone;
  return typeof metaPhone === "string" ? toE164Mx(metaPhone) || null : null;
}

function isUniqueViolation(error) {
  return String(error?.code || "") === "23505" || String(error?.message || "").includes("duplicate");
}

function isPhoneUniqueViolation(error) {
  const text = `${error?.message || ""} ${error?.details || ""}`;
  return isUniqueViolation(error) && text.includes(PHONE_UNIQUE_CONSTRAINT);
}

async function readOwnCustomer(user) {
  const { data } = await supabaseClient.from("customers").select("*").eq("auth_user_id", user.id).maybeSingle();
  return data || null;
}

export async function ensureCustomerProfile(user, { name, email, phone }) {
  if (!supabaseClient) return null;
  const existing = await readOwnCustomer(user);
  if (existing) return existing;

  const customerCode = await uniqueCustomerCode();
  const displayName =
    name || user.user_metadata?.name || user.user_metadata?.full_name || (user.email ? user.email.split("@")[0] : "") || "";

  const insertRow = {
    auth_user_id: user.id,
    name: displayName || "Cliente Salmos",
    email: email ? String(email).trim().toLowerCase() : user.email || null,
    phone: initialProfilePhone(user, phone),
    customer_code: customerCode,
  };

  let { data, error } = await supabaseClient.from("customers").insert(insertRow).select("*").single();

  if (error && insertRow.phone && isPhoneUniqueViolation(error)) {
    // El teléfono es de otro cliente: crear SIN teléfono (nunca tocar al otro).
    ({ data, error } = await supabaseClient
      .from("customers")
      .insert({ ...insertRow, phone: null })
      .select("*")
      .single());
    if (!error && data) return { ...data, phoneConflict: true };
  }

  if (error) {
    if (isUniqueViolation(error)) {
      // carrera por customer_code o auth_user_id: releer y devolver.
      const retry = await readOwnCustomer(user);
      if (retry) return retry;
    }
    throw error;
  }
  return data;
}

async function runLoyverseSync(profile) {
  if (profile.loyverse_customer_id && profile.loyverse_sync_status === "synced") {
    return { status: "already_synced", loyverseCustomerId: profile.loyverse_customer_id };
  }
  // H1: el cliente NUNCA escribe loyverse_customer_id / loyverse_sync_status.
  // La persistencia la hace la Edge Function con service_role; aquí solo se
  // obtiene el resultado para la sesión/UI (buildSession y retryLoyverseSync).
  try {
    return await createOrLinkLoyverseCustomer(profile);
  } catch {
    return { status: "failed", error: "loyverse_unavailable" };
  }
}

function toClientCustomer(profile) {
  return {
    id: profile.auth_user_id,
    profileId: profile.id,
    name: profile.name,
    email: profile.email || "",
    emailVerified: Boolean(profile.email_verified),
    phone: profile.phone || "",
    createdAt: profile.created_at,
    customerCode: profile.customer_code,
    loyverseCustomerId: profile.loyverse_customer_id,
    loyverseSyncStatus: profile.loyverse_sync_status,
    // true si el teléfono del registro ya pertenecía a otro cliente y la
    // fila se creó sin teléfono (ver ensureCustomerProfile).
    phoneConflict: Boolean(profile.phoneConflict),
  };
}

async function buildSession(user) {
  let profile;
  try {
    profile = await ensureCustomerProfile(user, {});
  } catch {
    return null;
  }
  // DEV BRIDGE: siembra el mock de lealtad para que Home/Rewards/etc.
  // sigan funcionando mientras la lealtad no migre a Supabase.
  ensureLoyaltyProfile(profile);

  // Vinculación Loyverse (idempotente: ya-sincronizadas no hacen nada).
  // Si falla la sesión se entrega igual y SyncBanner invita a reintentar.
  let syncStatus = profile.loyverse_sync_status || "pending";
  try {
    const sync = await runLoyverseSync(profile);
    if (
      sync.status === "created" ||
      sync.status === "updated" ||
      sync.status === "linked" ||
      sync.status === "already_synced"
    )
      syncStatus = "synced";
    else syncStatus = "failed";
  } catch {
    syncStatus = "failed";
  }

  return { customer: toClientCustomer({ ...profile, loyverse_sync_status: syncStatus }) };
}

// ---------------------------------------------------------------------------
// Sesión (helpers estables que la UI ya usa).
// ---------------------------------------------------------------------------

export async function getSession() {
  if (!supabaseClient) return null;
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();
  if (!session) return null;
  return buildSession(session.user);
}

export function onSessionChange(cb) {
  if (!supabaseClient) return () => {};
  const {
    data: { subscription },
  } = supabaseClient.auth.onAuthStateChange(() => cb());
  return () => subscription.unsubscribe();
}

export async function signOutClient() {
  if (supabaseClient) await supabaseClient.auth.signOut();
  pending = null;
  return { ok: true };
}

export async function retryLoyverseSync() {
  const { data: sessionData } = await supabaseClient.auth.getSession();
  if (!sessionData?.session?.user) return { ok: false };
  let profile;
  try {
    profile = await ensureCustomerProfile(sessionData.session.user, {});
  } catch {
    return { ok: false };
  }
  const result = await runLoyverseSync(profile);
  return { ok: result.status !== "failed" && result.status !== "conflict", ...result };
}

export function cancelPending() {
  pending = null;
}

// ---------------------------------------------------------------------------
// Auth PRINCIPAL — correo/teléfono + contraseña.
// ---------------------------------------------------------------------------

export async function signUpWithEmail({ email, password, name, phone }) {
  if (!supabaseClient) return { ok: false, error: makeError("NETWORK_ERROR") };

  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) return { ok: false, error: makeError("EMAIL_INVALID") };
  if (!password || password.length < MIN_PASSWORD) return { ok: false, error: makeError("WEAK_PASSWORD") };

  const data = { name: String(name || "").trim() };
  if (phone) data.phone = toE164Mx(phone) || String(phone).trim();

  const { data: result, error } = await supabaseClient.auth.signUp({
    email: cleanEmail,
    password,
    options: { data },
  });
  if (error) return { ok: false, error: toFriendlyError(error) };

  // Si el proyecto pide confirmar el correo, no hay sesión aún → la UI le
  // dice al cliente que revise su bandeja y vuelva a iniciar sesión.
  const mode = result?.session ? "complete" : "confirm_email";
  return { ok: true, mode };
}

export async function signInWithPassword({ identifier, password }) {
  if (!supabaseClient) return { ok: false, error: makeError("NETWORK_ERROR") };

  const cleanIdentifier = String(identifier || "").trim();
  if (!cleanIdentifier || !password) return { ok: false, error: makeError("INVALID_CREDENTIALS") };

  if (!isEmailIdentifier(cleanIdentifier)) {
    return signInWithPhonePassword(cleanIdentifier, password);
  }

  const { error } = await supabaseClient.auth.signInWithPassword({
    email: cleanIdentifier.toLowerCase(),
    password,
  });
  if (error) return { ok: false, error: toFriendlyError(error, "INVALID_CREDENTIALS") };
  return { ok: true };
}

// Teléfono + contraseña → Edge auth-phone-login → sesión GoTrue.
async function signInWithPhonePassword(phoneIdentifier, password) {
  const res = await callPhoneLogin({
    operation: "password",
    phone: phoneIdentifierForLogin(phoneIdentifier),
    password,
  });
  if (!res.ok) {
    if (res.code === "email_not_confirmed") return { ok: false, error: makeError("PHONE_EMAIL_NOT_CONFIRMED") };
    return { ok: false, error: phoneLoginError(res.code, "PHONE_INVALID_CREDENTIALS") };
  }
  return adoptSession(res.session);
}

export async function checkSecondaryContact({ method, value }) {
  if (!value) return { ok: true };
  if (!supabaseClient) return { ok: true };

  // RLS impide al anon leer `customers` antes del registro (siempre daría
  // ok:true). Se comprueba en el servidor con funciones que NO abren RLS
  // y devuelven SOLO existencia (booleano), nunca email ni filas:
  //  * phone_is_registered (0003)
  //  * email_is_registered (0020; antes resolve_email_for_login).
  if (method === "phone") {
    const normalized = toE164Mx(value) || String(value).trim();
    try {
      const { data, error } = await supabaseClient.rpc("phone_is_registered", {
        p_phone: normalized,
      });
      if (error) return { ok: false, error: toFriendlyError(error) };
      return data
        ? { ok: false, error: makeError("PHONE_IN_USE") }
        : { ok: true };
    } catch {
      return { ok: false, error: makeError("NETWORK_ERROR") };
    }
  }

  const email = String(value).trim().toLowerCase();
  try {
    const { data, error } = await supabaseClient.rpc("email_is_registered", {
      p_email: email,
    });
    if (error) return { ok: false, error: toFriendlyError(error) };
    return data === true
      ? { ok: false, error: makeError("EMAIL_ALREADY_EXISTS") }
      : { ok: true };
  } catch {
    return { ok: false, error: makeError("NETWORK_ERROR") };
  }
}

export async function resendConfirmationEmail({ email }) {
  if (!supabaseClient) return { ok: false };
  const { error } = await supabaseClient.auth.resend({
    type: "signup",
    email: String(email || "").trim().toLowerCase(),
  });
  if (error) return { ok: false };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Recuperación de contraseña — OTP por correo (fallback).
// ---------------------------------------------------------------------------

export async function forgotPasswordStart({ identifier }) {
  if (!supabaseClient) return { ok: false, error: makeError("NETWORK_ERROR") };

  const cleanIdentifier = String(identifier || "").trim();
  if (!cleanIdentifier) return { ok: false, error: makeError("INVALID_CREDENTIALS") };

  if (!isEmailIdentifier(cleanIdentifier)) {
    // Teléfono: la Edge responde IGUAL exista o no la cuenta, así que la
    // UI muestra un texto genérico ("tu correo registrado") en lugar del
    // email enmascarado, que delataba existencia y parte del correo.
    const phone = phoneIdentifierForLogin(cleanIdentifier);
    const res = await callPhoneLogin({ operation: "recover_start", phone });
    if (!res.ok) return { ok: false, error: phoneLoginError(res.code, "NETWORK_ERROR") };
    pending = { via: "phone", phone, identifier: cleanIdentifier };
    return { ok: true, maskedContact: "registrado" };
  }

  const email = cleanIdentifier.toLowerCase();
  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });
  if (error) return { ok: false, error: toFriendlyError(error, "NETWORK_ERROR") };

  pending = { via: "email", email, identifier: cleanIdentifier };
  return { ok: true, maskedContact: maskContact("email", email) };
}

export async function forgotPasswordVerify({ code }) {
  if (!pending) return { ok: false, error: makeError("OTP_INVALID") };

  if (pending.via === "phone") {
    const res = await callPhoneLogin({ operation: "recover_verify", phone: pending.phone, code: String(code) });
    if (!res.ok) return { ok: false, error: phoneLoginError(res.code, "OTP_INVALID") };
    // Sesión efímera (igual que verifyOtp) que setNewPassword aprovechará.
    return adoptSession(res.session);
  }

  const { error } = await supabaseClient.auth.verifyOtp({
    type: "email",
    email: pending.email,
    token: String(code),
  });
  if (error) return { ok: false, error: toFriendlyError(error, "OTP_INVALID") };
  // verifyOtp dejó una sesión efímera que setNewPassword aprovechará.
  return { ok: true };
}

export async function forgotPasswordResend() {
  if (!pending) return { ok: false };
  return forgotPasswordStart({ identifier: pending.identifier });
}

export async function setNewPassword({ newPassword }) {
  if (!supabaseClient) return { ok: false, error: makeError("NETWORK_ERROR") };
  if (!newPassword || newPassword.length < MIN_PASSWORD) return { ok: false, error: makeError("WEAK_PASSWORD") };

  const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
  if (error) return { ok: false, error: toFriendlyError(error, "NETWORK_ERROR") };
  pending = null;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Google — OAuth (el resultado llega por redirect → sesión).
// ---------------------------------------------------------------------------

export async function signInWithGoogle() {
  if (!supabaseClient) return { ok: false, error: makeError("NETWORK_ERROR") };
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) return { ok: false, error: toFriendlyError(error, "NETWORK_ERROR") };
    return { ok: true, status: "existing" };
  } catch {
    return { ok: false, error: makeError("NETWORK_ERROR") };
  }
}

// ---------------------------------------------------------------------------
// Perfil de rol (profiles). Lee la tabla profiles vía RLS: cada usuario
// autenticado solo puede leer su propio perfil (auth.uid() = id).
// ---------------------------------------------------------------------------

export async function getProfile() {
  if (!supabaseClient) return null;
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();
  if (!session?.user) return null;

  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, role, name, active")
    .eq("id", session.user.id)
    .maybeSingle();

  if (error || !data) return null;
  return { id: data.id, role: data.role, name: data.name, active: data.active };
}

// -- Staff no vive aquí: sigue en authService mock (facade). --------