// ---------------------------------------------------------------
// authService (implementación REAL) — Supabase Auth + customers.
//
// Mantiene EXACTAMENTE el mismo contrato público que el mock
// (identifyAccount/requestCode/verifyCode/...), así la UI que ya
// existe (AuthScreen y sus estados) no cambia. Diferencias internas
// respecto al mock:
//
//   * identifyAccount usa signInWithOtp({shouldCreateUser:false})
//     como probe anti-enumeración: sin error → la cuenta existe;
//     "Signups not allowed for otp" / "not allowed for otp" →
//     cuenta NO existe. La UI no percibe esto: solo ve
//     existing | new.
//   * verifyCode usa supabase.auth.verifyOtp (el código lo maneja
//     Supabase, no nosotros).
//   * completeRegistration asegura el perfil `customers` en la base
//     real (con customer_code único) y dispara la sincronización con
//     Loyverse a través de la Edge Function segura — nunca directo.
//   * La sesión sobrevive refresh (persistSession + onAuthStateChange).
//
// Google queda encapsulado (signInWithGoogle). Su flujo completo de
// confirmación para usuarios nuevos se afinará cuando estén las
// credenciales de producción.
// ---------------------------------------------------------------

import { supabaseClient } from "../../lib/supabase/client.js";
import { generateCustomerCode } from "../../lib/customerCode.js";
import { ensureLoyaltyProfile } from "../customers/customerService.js";
import { createOrLinkLoyverseCustomer } from "../loyverse/loyverseCustomerService.js";

// Verificación pendiente (identify → código enviado → verificar).
// En real no guardamos el código (lo maneja Supabase); solo el contexto
// de qué camino estamos recorriendo (new | existing, email | phone).
let pending = null;

function normalizePhoneDigits(value) {
  return String(value).replace(/\D/g, "");
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

function isUserNotFoundError(error) {
  const msg = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "");
  return (
    msg.includes("signups not allowed") ||
    msg.includes("not allowed for otp") ||
    msg.includes("user not found") ||
    code === "otp_disabled" ||
    code === "signup_disabled"
  );
}

// Envía un OTP (email o phone). Devuelve "existing" | "new" | "transient".
async function sendOtp(method, value, { shouldCreateUser }) {
  if (!supabaseClient) return "transient";
  const options = { shouldCreateUser };
  const { error } =
    method === "email"
      ? await supabaseClient.auth.signInWithOtp({ email: value.trim().toLowerCase(), options })
      : await supabaseClient.auth.signInWithOtp({ phone: value, options });

  if (!error) return "existing";
  if (isUserNotFoundError(error)) return "new";
  return "transient";
}

async function getCurrentUser() {
  if (!supabaseClient) return null;
  const {
    data: { user },
  } = await supabaseClient.auth.getUser();
  return user;
}

// ---------------------------------------------------------------------------
// Perfil `customers` (Supabase). La filta real del cliente de Salmos.
// ---------------------------------------------------------------------------

function buildEmailPhone(user, { primary, secondary }) {
  let email = null;
  let phone = null;

  if (primary) {
    if (primary.method === "email") email = primary.value.trim().toLowerCase();
    else phone = primary.value;
  }
  if (!email && (user.email || user.user_metadata?.email)) email = (user.email || user.user_metadata.email).toLowerCase();
  if (!phone && (user.phone || user.user_metadata?.phone)) phone = user.phone || user.user_metadata.phone;

  if (secondary) {
    if (secondary.method === "email") email = (email || secondary.value).toLowerCase();
    else if (!phone) phone = secondary.value;
  }
  return { email, phone };
}

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
    email: email ?? null,
    email_verified: Boolean(user.email_confirmed_at),
    phone: phone ?? null,
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
  // Persistimos el desenlace en la fila del cliente para que la sesión
  // (y el banner de sync) reflejen la realidad aunque la Edge Function
  // guarde el estado por su cuenta. RLS: solo es la fila del usuario.
  const dbStatus =
    result.status === "created" || result.status === "linked" || result.status === "already_synced"
      ? "synced"
      : result.status === "conflict"
        ? "failed"
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
  return { customer: toClientCustomer(profile) };
}

// ---------------------------------------------------------------------------
// Contrato público (idéntico al mock) + helpers de sesión.
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

export async function identifyAccount({ method, value }) {
  const outcome = await sendOtp(method, value, { shouldCreateUser: false });
  if (outcome === "transient") return { ok: false, error: "transient" };
  return {
    ok: true,
    status: outcome, // existing | new
    method,
    value,
    maskedContact: maskContact(method, value),
  };
}

export async function requestCode({ method, value, forNewAccount }) {
  const outcome = await sendOtp(method, value, { shouldCreateUser: true });
  if (outcome === "transient") return { ok: false, error: "transient" };
  pending = { mode: forNewAccount ? "new" : "existing", method, value };
  return { ok: true, maskedContact: maskContact(method, value) };
}

export async function verifyCode({ code }) {
  if (!pending) return { ok: false, error: "no_pending" };
  const type = pending.method === "email" ? "email" : "sms";
  const payload =
    type === "email"
      ? { type, email: pending.value.trim().toLowerCase(), token: code }
      : { type, phone: pending.value, token: code };

  const { error } = await supabaseClient.auth.verifyOtp(payload);
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("expire")) return { ok: false, error: "expired" };
    return { ok: false, error: "invalid" };
  }
  return { ok: true, mode: pending.mode };
}

export async function resendCode() {
  if (!pending) return { ok: false, error: "no_pending" };
  return requestCode({ method: pending.method, value: pending.value, forNewAccount: pending.mode === "new" });
}

export function cancelPending() {
  pending = null;
}

export async function checkSecondaryContact({ method, value }) {
  if (!value) return { ok: true };
  if (!supabaseClient) return { ok: true };
  const user = await getCurrentUser();
  let query = supabaseClient
    .from("customers")
    .select("id")
    .neq("auth_user_id", user?.id || "");
  query =
    method === "email"
      ? query.eq("email", value.trim().toLowerCase())
      : query.eq("phone", value);
  const { data } = await query.limit(1).maybeSingle();
  if (data) {
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

export async function signInWithGoogle() {
  if (!supabaseClient) return { ok: false, error: "transient" };
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) return { ok: false, error: "Google no está disponible todavía." };
    return { ok: true, status: "existing" };
  } catch {
    return { ok: false, error: "transient" };
  }
}

export async function completeRegistration({ name, secondaryContact, googleProfile }) {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "not_verified" };

  if (googleProfile) {
    // La sesión OAuth ya existe; solo aseguramos perfil + sync.
    const profile = await ensureCustomerProfile(user, {
      name: name || user.user_metadata?.name || user.user_metadata?.full_name,
      email: user.email || googleProfile.email || null,
      phone: secondaryContact?.method === "phone" ? secondaryContact.value : null,
    });
    const sync = await runLoyverseSync(profile);
    pending = null;
    return { ok: true, loyverseSyncStatus: sync.status };
  }

  // Camino OTP: la identidad ya quedó verificada en verifyCode.
  // Guardamos el nombre en user_metadata para que el perfil lo herede.
  if (name && name.trim()) {
    await supabaseClient.auth.updateUser({ data: { ...(user.user_metadata || {}), name: name.trim() } });
  }
  const refreshed = await getCurrentUser();

  const primary = pending ? { method: pending.method, value: pending.value } : null;
  const { email, phone } = buildEmailPhone(refreshed, { primary, secondary: secondaryContact });

  const profile = await ensureCustomerProfile(refreshed, { name: name || undefined, email, phone });
  const sync = await runLoyverseSync(profile);
  pending = null;
  return { ok: true, loyverseSyncStatus: sync.status };
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

// -- Staff no vive aquí: sigue en authService mock (facade). --------