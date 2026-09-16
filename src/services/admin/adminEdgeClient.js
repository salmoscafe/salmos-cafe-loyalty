// ---------------------------------------------------------------
// adminEdgeClient — única puerta del frontend hacia la Edge Function
// `admin-employees`. Todas las mutaciones administrativas de empleados
// pasan por aquí.
//
// Seguridad:
//   * Se autentica con el JWT de la sesión (Authorization header); la
//     Edge revalida que el perfil sea role='admin' + active=true con la
//     clave de servicio del lado servidor. El frontend jamás la ve: esa
//     clave solo existe en la variable de entorno de la Edge Function.
//   * El rol del empleado NO viaja en el payload: la Edge lo fuerza a
//     'staff'. role='admin' desde el cliente es rechazado server-side.
// ---------------------------------------------------------------

import { supabaseClient, isSupabaseConfigured } from "../../lib/supabase/client.js";
import { readEnv } from "../../lib/utils/env.js";

export function adminEmployeesFunctionUrl() {
  const configuredUrl = readEnv("VITE_ADMIN_EMPLOYEES_FUNCTION_URL");
  if (configuredUrl) {
    return configuredUrl;
  }
  const supabaseUrl = readEnv("VITE_SUPABASE_URL");
  if (supabaseUrl) {
    return `${supabaseUrl}/functions/v1/admin-employees`;
  }
  return null;
}

// `payload` = { action: 'create'|'list'|'update', ...campos de la acción }.
export async function callAdminEdge(payload) {
  if (!isSupabaseConfigured) {
    return { ok: false, code: "admin_unavailable", retriable: true };
  }
  const url = adminEmployeesFunctionUrl();
  if (!url) return { ok: false, code: "admin_unavailable", retriable: true };

  const {
    data: { session },
  } = await supabaseClient.auth.getSession();
  const token = session?.access_token;
  if (!token) return { ok: false, code: "unauthorized", message: "Tu sesión expiró." };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, code: "admin_unavailable", retriable: true, message: "No pudimos conectar con el servidor." };
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const parsed = body || {};

  if (!res.ok) {
    return {
      ok: false,
      code: parsed.code || "admin_error",
      message: parsed.message || "La operación no se pudo completar.",
      retriable: Boolean(parsed.retriable),
    };
  }

  return { ok: true, ...parsed };
}