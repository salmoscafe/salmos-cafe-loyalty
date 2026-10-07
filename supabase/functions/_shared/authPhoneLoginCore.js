// ---------------------------------------------------------------
// authPhoneLoginCore — lógica pura de la Edge `auth-phone-login`.
//
// Problema que resuelve (auditoría 2026-10-07): el login por teléfono
// llamaba desde el navegador (anon) a la RPC resolve_email_for_login,
// que devolvía el EMAIL de cualquier teléfono registrado. Ahora:
//
//   navegador ──(teléfono + contraseña)──▶ auth-phone-login
//        Edge: teléfono → email (RPC, solo service_role) → GoTrue
//   navegador ◀──(solo tokens de sesión, o error genérico)──
//
// Garantías (verificadas en tests/auth-phone-login-core.test.mjs):
//   * El email NUNCA sale del servidor (ni en éxito ni en error).
//   * Teléfono inexistente, ambiguo o contraseña incorrecta producen
//     EXACTAMENTE la misma respuesta (status + body): no hay oráculo.
//   * Para un teléfono sin cuenta también se consulta a GoTrue (con un
//     email señuelo imposible), de modo que el costo en rate limit y el
//     camino de red son equivalentes; además toda respuesta dependiente
//     de credenciales se emite tras un piso de tiempo (MIN_RESPONSE_MS).
//   * La contraseña y el OTP solo los valida Supabase Auth (GoTrue).
//     Aquí no hay criptografía propia, ni almacenamiento de secretos,
//     ni sesiones propias: se devuelve la sesión que emite GoTrue.
//
// 100% agnóstico de Deno/Supabase: recibe `deps` inyectadas, por eso es
// unit-testable con node --test.
// ---------------------------------------------------------------

export const PHONE_LOGIN_OPERATIONS = Object.freeze(["password", "recover_start", "recover_verify"]);

// Piso de latencia para respuestas que dependen de si la cuenta existe.
export const MIN_RESPONSE_MS = 800;

// Dominio reservado (RFC 2606): un email señuelo jamás puede existir.
export const DECOY_EMAIL_DOMAIN = "phone-login.invalid";

const ALLOWED_FIELDS = new Set(["operation", "phone", "password", "code"]);
const MAX_PASSWORD_LENGTH = 256;
const OTP_RE = /^\d{6,10}$/;

function digitsOf(value) {
  return String(value ?? "").replace(/\D/g, "");
}

// Misma normalización que el cliente (src/lib/phone.js → toE164Mx):
// 10 dígitos nacionales (o 52 + 10) → +52XXXXXXXXXX. Otros formatos
// internacionales (11–15 dígitos) se conservan como +<dígitos>; la RPC
// compara por dígitos, igual que antes.
export function normalizePhoneForLogin(value) {
  const digits = digitsOf(value);
  if (!digits) return null;
  const national = digits.startsWith("52") && digits.length === 12 ? digits.slice(2) : digits;
  if (national.length === 10) return `+52${national}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

function invalidRequest() {
  return { status: 400, body: { ok: false, code: "invalid_request", retriable: false } };
}

// Valida el body. Rechaza campos extra (en particular `email`: esta
// Edge NO es un proxy genérico de login).
export function validatePhoneLoginRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false };
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) return { ok: false };
  }
  const { operation, phone, password, code } = body;
  if (!PHONE_LOGIN_OPERATIONS.includes(operation)) return { ok: false };
  if (typeof phone !== "string" || phone.includes("@")) return { ok: false };
  const normalizedPhone = normalizePhoneForLogin(phone);
  if (!normalizedPhone) return { ok: false };

  if (operation === "password") {
    if (typeof password !== "string" || !password || password.length > MAX_PASSWORD_LENGTH) return { ok: false };
    if (code !== undefined) return { ok: false };
    return { ok: true, data: { operation, phone: normalizedPhone, password } };
  }
  if (operation === "recover_start") {
    if (password !== undefined || code !== undefined) return { ok: false };
    return { ok: true, data: { operation, phone: normalizedPhone } };
  }
  // recover_verify
  if (typeof code !== "string" || !OTP_RE.test(code)) return { ok: false };
  if (password !== undefined) return { ok: false };
  return { ok: true, data: { operation, phone: normalizedPhone, code } };
}

// IP del usuario final para `Sb-Forwarded-For` (rate limit por IP real
// en GoTrue). Primer valor de x-forwarded-for; null si no parece IP.
export function clientIpFrom(headers) {
  const raw = typeof headers?.get === "function" ? headers.get("x-forwarded-for") : null;
  if (!raw) return null;
  const first = String(raw).split(",")[0].trim();
  if (/^[0-9.]{7,15}$/.test(first) || /^[0-9a-fA-F:]{2,39}$/.test(first)) return first;
  return null;
}

// Solo los campos necesarios para supabase.auth.setSession(): nada de
// `user` (que trae el email) ni metadatos.
export function pickSessionTokens(session) {
  if (!session || typeof session.access_token !== "string" || typeof session.refresh_token !== "string") {
    return null;
  }
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: typeof session.expires_in === "number" ? session.expires_in : null,
    expires_at: typeof session.expires_at === "number" ? session.expires_at : null,
    token_type: typeof session.token_type === "string" ? session.token_type : "bearer",
  };
}

function isRateLimited(error) {
  if (!error) return false;
  const code = String(error.code || "").toLowerCase();
  return Number(error.status) === 429 || code.includes("rate_limit");
}

function isEmailNotConfirmed(error) {
  if (!error) return false;
  const code = String(error.code || "").toLowerCase();
  const msg = String(error.message || "").toLowerCase();
  return code === "email_not_confirmed" || /email not confirmed/.test(msg);
}

const INVALID_CREDENTIALS = { status: 401, body: { ok: false, code: "invalid_credentials", retriable: false } };
const OTP_INVALID = { status: 401, body: { ok: false, code: "otp_invalid", retriable: false } };
const RATE_LIMITED = { status: 429, body: { ok: false, code: "rate_limited", retriable: true } };
const UNAVAILABLE = { status: 503, body: { ok: false, code: "service_unavailable", retriable: true } };

// deps:
//   resolveEmail(phone)            → email | null   (lanza si la base falla)
//   signInWithPassword(email, pw)  → { session, error }
//   sendOtp(email)                 → { error }
//   verifyOtp(email, code)         → { session, error }
//   now() → ms, sleep(ms), randomId() → string
export async function handlePhoneLogin(body, deps) {
  const check = validatePhoneLoginRequest(body);
  if (!check.ok) return invalidRequest();

  const startedAt = deps.now();
  const result = await decide(check.data, deps);
  const elapsed = deps.now() - startedAt;
  if (elapsed < MIN_RESPONSE_MS) await deps.sleep(MIN_RESPONSE_MS - elapsed);
  return result;
}

async function decide(data, deps) {
  let email = null;
  try {
    email = await deps.resolveEmail(data.phone);
  } catch {
    return UNAVAILABLE;
  }
  const hasAccount = typeof email === "string" && email.includes("@");
  const target = hasAccount ? email : `no-account-${deps.randomId()}@${DECOY_EMAIL_DOMAIN}`;

  try {
    if (data.operation === "password") {
      const { session, error } = await deps.signInWithPassword(target, data.password);
      const tokens = hasAccount && !error ? pickSessionTokens(session) : null;
      if (tokens) return { status: 200, body: { ok: true, session: tokens } };
      if (isRateLimited(error)) return RATE_LIMITED;
      // Solo alcanzable con la contraseña CORRECTA de una cuenta real:
      // no es un oráculo de existencia para quien no la conoce.
      if (hasAccount && isEmailNotConfirmed(error)) {
        return { status: 403, body: { ok: false, code: "email_not_confirmed", retriable: false } };
      }
      return INVALID_CREDENTIALS;
    }

    if (data.operation === "recover_start") {
      // Respuesta SIEMPRE idéntica: exista o no la cuenta, y aunque GoTrue
      // responda con su límite por usuario (60 s), que delataría existencia.
      await deps.sendOtp(target).catch(() => null);
      return { status: 200, body: { ok: true } };
    }

    // recover_verify
    const { session, error } = await deps.verifyOtp(target, data.code);
    const tokens = hasAccount && !error ? pickSessionTokens(session) : null;
    if (tokens) return { status: 200, body: { ok: true, session: tokens } };
    if (isRateLimited(error)) return RATE_LIMITED;
    return OTP_INVALID;
  } catch {
    // Fallo de red hacia GoTrue: mismo resultado para cuentas existentes
    // y señuelo (ambos caminos llaman a GoTrue).
    return UNAVAILABLE;
  }
}
