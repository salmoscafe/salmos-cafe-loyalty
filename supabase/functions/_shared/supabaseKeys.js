// ---------------------------------------------------------------
// supabaseKeys.js — lectura de las nuevas API keys de Supabase.
//
// Las keys nuevas llegan al runtime de las Edge Functions como un
// diccionario JSON por nombre (`{"default":"sb_..."}`), NO como string
// plano como las legacy (`SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`).
// Este helper aísla ese detalle para no duplicarlo en cada función.
//
// Seguridad:
//   * El valor de la key jamás se registra en logs ni se hardcodea.
//   * Fail-closed: si el JSON falta, está corrupto o no existe la key
//     "default", devuelve "" y el handler responde 503.
// ---------------------------------------------------------------

export function readDefaultKey(rawJson) {
  if (!rawJson) return "";
  try {
    const parsed = JSON.parse(rawJson);
    if (parsed && typeof parsed === "object" && typeof parsed["default"] === "string") {
      return parsed["default"];
    }
  } catch {
    // JSON inválido → sin key (fail-closed).
  }
  return "";
}
