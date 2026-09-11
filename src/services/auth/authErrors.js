// ---------------------------------------------------------------
// authErrors — traducción de errores a códigos + mensajes amigables
// en español. Es el ÚNICO lugar donde el frontend decide qué frase
// ve el cliente. Nunca filtra mensajes crudos de Supabase por debajo
// de esta capa (no queremos stack traces, ni códigos, ni URLs).
// ---------------------------------------------------------------

export const AUTH_ERRORS = {
  INVALID_CREDENTIALS: {
    code: "INVALID_CREDENTIALS",
    message: "Tu correo o contraseña no son correctos. Revisa e intenta de nuevo.",
  },
  EMAIL_NOT_CONFIRMED: {
    code: "EMAIL_NOT_CONFIRMED",
    message: "Todavía no confirmas tu correo. Revisa tu bandeja de entrada (y el spam) y confirma tu cuenta.",
  },
  EMAIL_ALREADY_EXISTS: {
    code: "EMAIL_ALREADY_EXISTS",
    message: "Ese correo ya está registrado. Inicia sesión o usa Google.",
  },
  EMAIL_INVALID: {
    code: "EMAIL_INVALID",
    message: "Escribe un correo válido.",
  },
  WEAK_PASSWORD: {
    code: "WEAK_PASSWORD",
    message: "La contraseña debe tener al menos 8 caracteres.",
  },
  PASSWORD_MISMATCH: {
    code: "PASSWORD_MISMATCH",
    message: "Las contraseñas no coinciden.",
  },
  PHONE_IN_USE: {
    code: "PHONE_IN_USE",
    message: "Ese teléfono ya está asociado a otra cuenta de Salmos.",
  },
  ACCOUNT_NOT_FOUND: {
    code: "ACCOUNT_NOT_FOUND",
    message: "No encontramos una cuenta con ese correo o teléfono.",
  },
  OTP_INVALID: {
    code: "OTP_INVALID",
    message: "Ese código no es correcto.",
  },
  OTP_EXPIRED: {
    code: "OTP_EXPIRED",
    message: "Este código venció. Pide uno nuevo.",
  },
  GOOGLE_CONFLICT: {
    code: "GOOGLE_CONFLICT",
    message: "Ese correo ya tiene una cuenta de Salmos. Entra con tu correo y contraseña.",
  },
  NETWORK_ERROR: {
    code: "NETWORK_ERROR",
    message: "No pudimos conectar. Revisa tu conexión e intenta de nuevo.",
  },
};

export function makeError(code, message) {
  const known = AUTH_ERRORS[code];
  return {
    code,
    message: message || known?.message || "Algo salió mal. Intenta de nuevo.",
  };
}

export function isWeakPasswordHint(raw) {
  const msg = String(raw || "").toLowerCase();
  return /weak|short|6+ characters|at least|shorter than/i.test(msg);
}

// Mapea un error crudo de Supabase Auth a nuestro shape amigable.
export function toFriendlyError(raw, fallbackCode = "NETWORK_ERROR") {
  const msg = String(raw?.message || "").toLowerCase();
  const code = String(raw?.code || "").toLowerCase();

  if (/already registered|email already in use|exists/.test(msg) || code === "user_already_exists") {
    return makeError("EMAIL_ALREADY_EXISTS");
  }
  if (/invalid login credentials|invalid_credentials|invalid email or password/.test(msg)) {
    return makeError("INVALID_CREDENTIALS");
  }
  if (/email not confirmed|not confirmed/.test(msg)) {
    return makeError("EMAIL_NOT_CONFIRMED");
  }
  if (/identity already linked|third party|provider.*account|already been registered/.test(msg)) {
    return makeError("GOOGLE_CONFLICT");
  }
  if (isWeakPasswordHint(msg)) {
    return makeError("WEAK_PASSWORD");
  }
  if (/expired|expire/.test(msg)) {
    return makeError("OTP_EXPIRED");
  }
  if (/invalid token|otp.*invalid|incorrect/.test(msg)) {
    return makeError("OTP_INVALID");
  }
  if (/user not found|no user found|signups not allowed|otp_disabled/.test(msg)) {
    return makeError("ACCOUNT_NOT_FOUND");
  }
  if (/fetch|network|offline|failed to fetch|server error|connection/.test(msg)) {
    return makeError("NETWORK_ERROR");
  }
  return makeError(fallbackCode);
}