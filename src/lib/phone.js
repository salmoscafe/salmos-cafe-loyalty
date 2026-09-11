// ---------------------------------------------------------------
// Utilidades de teléfono del lado cliente.
// Los teléfonos se guardan SIEMPRE en E.164 (+529801234567). Para
// México el prefijo es +52 y el número nacional tiene 10 dígitos.
// ---------------------------------------------------------------

export function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function toE164Mx(value) {
  const digits = phoneDigits(value);
  if (!digits) return null;
  // Si alguien ya escribió el 52 seguido, no lo duplicamos.
  const national = digits.startsWith("52") && digits.length === 12 ? digits.slice(2) : digits;
  if (national.length !== 10) return null;
  return `+52${national}`;
}

export function isLikelyMexicanPhone(value) {
  return toE164Mx(value) !== null;
}