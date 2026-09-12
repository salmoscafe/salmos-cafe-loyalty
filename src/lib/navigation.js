// Navegación por pathname (sin router): la SPA decide qué experiencia
// (Cliente / Staff / Admin) mostrar según la URL. En producción son
// despliegues/dominios separados; aquí se resuelve por la primera ruta.

export const APP_MODES = ["client", "staff", "admin"];

// Convierte un pathname en el modo de la app. Es puramente funcional
// (acepta el string) para poder testearla sin navegador.
//   "/"        → "client"
//   "/Staff"   → "staff"   (case-insensitive, tolera barra final y subrutas)
//   "/Admin"   → "admin"
//   cualquier otra → "client" (default por seguridad)
export function resolveAppMode(pathname = "/") {
  const firstSegment = pathname.split("/")[1];
  const key = (firstSegment || "").toLowerCase();
  if (key === "staff") return "staff";
  if (key === "admin") return "admin";
  return "client";
}

export function modePath(mode) {
  if (mode === "staff") return "/Staff";
  if (mode === "admin") return "/Admin";
  return "/";
}