// ---------------------------------------------------------------
// Lectura centralizada del entorno. Único lugar del frontend que
// sabe cómo existe import.meta.env (Vite) y qué pasa si no estamos
// en bundler (tests en Node). Los servicios leen el entorno SOLO a
// través de `readEnv`, nunca replicando esta expresión.
// ---------------------------------------------------------------

const source = (typeof import.meta !== "undefined" && import.meta.env) || {};

export function readEnv(key, fallback = "") {
  return source[key] || fallback;
}