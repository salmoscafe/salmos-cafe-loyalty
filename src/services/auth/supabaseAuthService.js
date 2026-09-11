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
//     El teléfono se resuelve a email con la función segura
//     resolve_email_for_login (migración 0003, SECURITY DEFINER) para
//     NO romper RLS; la validación de la contraseña la hace SIEMPRE
//     GoTrue, nunca esa función.
//   * forgotPasswordStart envía un código al correo (un solo de uso)
//     vía signInWithOtp({shouldCreateUser:false}); no hay proveedor SMS
//     configurado, así que aún con teléfono la recuperación va al correo.
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

// Resuelve "email o teléfono" → email de la cuenta.
//   * Identificadores con "@" pasan directo a GoTrue (él decide el error).
//   * Teléfonos se resuelven vía RPC seguro (solo devuelve email si hay
//     UNA coincidencia exacta por dígitos). Sin coincidencia → la app
//     pide usar el correo ("No encontramos una cuenta…").
async function resolveLoginEmail(identifierRaw) {
  const identifier = String(identifierRaw || "").trim();
  if (!identifier) return { ok: false, error: makeError("INVALID_CREDENTIALS") };

  if (identifier.includes("@")) {
    return { ok: true, email: identifier.toLowerCase() };
  }

  if (!supabaseClient) return { ok: false, error: makeError("NETWORK_ERROR") };
  try {
    const { data, error } = await supabaseClient.rpc("resolve_email_for_login", {
      p_identifier: phoneIdentifierForLogin(identifier),
    });
    if (error) return { ok: false, error: toFriendlyError(error) };
    if (!data) return { ok: false, error: makeError("ACCOUNT_NOT_FOUND") };
    return { ok: true, email: String(data).toLowerCase() };
  } catch {
    return { ok: false, error: makeError("NETWORK_ERROR") };
  }
}

// Normaliza el teléfono a E.164 (+52) ANTES de mandarlo al RPC, porque en
// `customers` se almacena E.164 y el usuario escribe normalmente 10 dígitos.
// Si no se puede deducir un teléfono mexicano válido se pasa el texto tal
// cual: el RPC decide por dígitos y no lo reconoce (cuenta no encontrada).
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
export async function ensureCustomerProfile(user, { name, email, phone }) {
  if (!supabaseClient) return null;
  const { data: existing } = await supabaseClient
    .from("customers")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (existing) return existing;

  const customerCode = await uniqueCustomerCode();
  const displayName =
    name || user.user_metadata?.name || user.user_metadata?.full_name || (user.email ? user.email.split("@")[0] : "") || "";

  const insertRow = {
    auth_user_id: user.id,
    name: displayName || "Cliente Salmos",
    email: email ? String(email).trim().toLowerCase() : user.email || null,
    email_verified: Boolean(user.email_confirmed_at),
    phone: phone ? toE164Mx(phone) || String(phone).trim() : user.phone || null,
    customer_code: customerCode,
    loyverse_sync_status: "pending",
  };

  const { data, error } = await supabaseClient.from("customers").insert(insertRow).select("*").single();
  if (error) {
    if (String(error.message || "").includes("duplicate") || String(error.code || "") === "23505") {
      // carrera por customer_code o auth_user_id: releer y devolver.
      const { data: retry } = await supabaseClient.from("customers").select("*").eq("auth_user_id", user.id).maybeSingle();
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
  let result;
  try {
    result = await createOrLinkLoyverseCustomer(profile);
  } catch {
    result = { status: "failed", error: "loyverse_unavailable" };
  }
  const dbStatus =
    result.status === "created" ||
    result.status === "updated" ||
    result.status === "linked" ||
    result.status === "already_synced"
      ? "synced"
      : "failed";
  await supabaseClient
    .from("customers")
    .update({
      loyverse_customer_id: result.loyverseCustomerId || profile.loyverse_customer_id || null,
      loyverse_sync_status: dbStatus,
    })
    .eq("auth_user_id", profile.auth_user_id);
  return result;
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

  const resolved = await resolveLoginEmail(identifier);
  if (!resolved.ok) return resolved;
  if (!password) return { ok: false, error: makeError("INVALID_CREDENTIALS") };

  const { error } = await supabaseClient.auth.signInWithPassword({
    email: resolved.email,
    password,
  });
  if (error) return { ok: false, error: toFriendlyError(error, "INVALID_CREDENTIALS") };
  return { ok: true };
}

export async function checkSecondaryContact({ method, value }) {
  if (!value) return { ok: true };
  if (!supabaseClient) return { ok: true };

  // RLS impide al anon leer `customers` antes del registro (siempre daría
  // ok:true). Se comprueba en el servidor con funciones que NO abren RLS:
  //  * phone_is_registered → sólo EXISTENCIA (booleano), sin email ni filas.
  //  * resolve_email_for_login → email sólo si hay UNA cuenta con ese valor.
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
    const { data, error } = await supabaseClient.rpc("resolve_email_for_login", {
      p_identifier: email,
    });
    if (error) return { ok: false, error: toFriendlyError(error) };
    return data && String(data).toLowerCase() === email
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

  const resolved = await resolveLoginEmail(identifier);
  if (!resolved.ok) return resolved;

  const { error } = await supabaseClient.auth.signInWithOtp({
    email: resolved.email,
    options: { shouldCreateUser: false },
  });
  if (error) return { ok: false, error: toFriendlyError(error, "NETWORK_ERROR") };

  pending = { email: resolved.email, identifier };
  return { ok: true, maskedContact: maskContact("email", resolved.email) };
}

export async function forgotPasswordVerify({ code }) {
  if (!pending) return { ok: false, error: makeError("OTP_INVALID") };
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

// -- Staff no vive aquí: sigue en authService mock (facade). --------