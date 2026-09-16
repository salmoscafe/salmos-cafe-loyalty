// ---------------------------------------------------------------
// admin-employees — Edge Function segura para ADMIN → EMPLEADOS
// (CHECKPOINT 2).
//
// Operaciones (dispatch por body.action):
//   * create — crea una cuenta Supabase Auth (email + contraseña) y un
//              perfil en public.profiles con role='staff', active=true.
//   * list   — empleados (profiles role='staff') con su email (GoTrue).
//   * update — cambia name y/o active de un empleado (nunca el rol).
//
// Seguridad (CHECKPOINT 2 §Parte 10 — obligatorio):
//   * verify_jwt = true (supabase/config.toml) exige sesión GoTrue.
//   * La función valida el usuario con auth.getUser(token) (defense in
//     depth, mismo patrón que loyalty-engine / loyverse-customers).
//   * El rol del actor se resuelve server-side leyendo public.profiles
//     con service_role; solo un perfil role='admin' + active='true'
//     ejecuta estas operaciones. NUNCA se confía en un role enviado
//     desde React ni en user_metadata.
//   * El role del empleado creado SIEMPRE es 'staff': si el cliente
//     envía role='admin' se rechaza (ROLE_NOT_ALLOWED).
//   * La creación de usuarios usa la Admin Auth API (service_role):
//     SUPABASE_SERVICE_ROLE_KEY vive SOLO aquí, nunca en src/ ni en el
//     bundle. El navegador jamás la ve.
//   * Idempotencia: si el email ya existe, se responde
//     email_already_exists (409) sin crear cuenta ni segundo perfil.
//
// Despliegue: supabase functions deploy admin-employees
// Vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// ---------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  buildEmployeeList,
  requireAdmin,
  validateAction,
  validateCreateEmployee,
  validateUpdateEmployee,
} from "../_shared/adminEmployeesCore.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Consulta public.profiles con service_role (fuente de verdad del rol).
// Devuelve { id, role, name, active } o null.
async function fetchProfile(serviceClient, userId) {
  const { data, error } = await serviceClient
    .from("profiles")
    .select("id, role, name, active")
    .eq("id", userId)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

async function parseJson(req) {
  try {
    return { ok: true, data: await req.json() };
  } catch {
    return { ok: false, error: { code: "INVALID_BODY", message: "El cuerpo de la solicitud no es JSON válido.", status: 400 } };
  }
}

// Crea la cuenta Auth (Admin API) y el perfil staff, de forma atómica
// frente a duplicados: `email_already_exists` se traduce a 409 sin
// tocar profiles.
async function createEmployee({ auth, serviceClient, data }) {
  const { email, password, name } = data;

  let created;
  try {
    created = await auth.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name },
    });
  } catch (error) {
    const msg = String(error?.message || "").toLowerCase();
    const code = String(error?.code || "").toLowerCase();
    if (/already registered|email already in use|exists/.test(msg) || code === "user_already_exists") {
      return {
        ok: false,
        status: 409,
        body: { ok: false, code: "email_already_exists", message: "Ese correo ya está registrado. No se creó una segunda cuenta.", retriable: false },
      };
    }
    throw error;
  }

  const userId = created?.user?.id;
  if (!userId) throw new Error("createUser sin id de usuario");

  // Upsert del perfil: cubre tanto el caso del trigger on_auth_user_created
  // (fila customer ya creada) como la ausencia del trigger (insert directo).
  // El rol SIEMPRE lo decide el servidor: staff, nunca lo que envíe el cliente.
  const { error: upsertError } = await serviceClient
    .from("profiles")
    .upsert({ id: userId, role: "staff", name, active: true }, { onConflict: "id" });
  if (upsertError) throw upsertError;

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      employee: { id: userId, email, name, role: "staff", active: true },
    },
  };
}

async function listEmployees({ supabase, serviceClient }) {
  // Empleados = perfiles con role='staff'. El admin NO se lista ni se
  // gestiona desde esta pantalla (V1). El email se une con la Admin API.
  const { data: profiles, error: profilesError } = await serviceClient
    .from("profiles")
    .select("id, role, name, active")
    .eq("role", "staff");
  if (profilesError) throw profilesError;

  // Emails: GoTrue (Admin API). El navegador no debe leer auth.users.
  const { data: page } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const users = page?.users || [];

  return {
    ok: true,
    status: 200,
    body: { ok: true, employees: buildEmployeeList(profiles || [], users) },
  };
}

async function updateEmployee({ auth, serviceClient, data }) {
  const { employeeId, name, active } = data;

  // Solo perfiles role='staff' son gestionables: un `employeeId` de un
  // admin (o inexistente) no matchea `.eq('role', 'staff')` → 404.
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (active !== undefined) patch.active = active;

  const { data: updated, error, count } = await serviceClient
    .from("profiles")
    .update(patch)
    .eq("id", employeeId)
    .eq("role", "staff")
    .select("id, role, name, active")
    .maybeSingle();

  if (error) throw error;
  if (!updated) {
    return {
      ok: false,
      status: 404,
      body: { ok: false, code: "employee_not_found", message: "No se encontró ese empleado.", retriable: false },
    };
  }

  // Email para la respuesta (visualización inmediata en la UI).
  let email = "";
  try {
    const { data: user } = await auth.auth.admin.getUserById(employeeId);
    email = user?.user?.email || "";
  } catch {
    email = "";
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      employee: { id: updated.id, name: updated.name, email, role: updated.role, active: updated.active },
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed", message: "Solo se acepta POST.", retriable: false }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  try {
    // 1) Autenticación: JWT del usuario.
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      return json({ ok: false, code: "unauthorized", message: "Autenticación requerida.", retriable: false }, 401);
    }

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return json({ ok: false, code: "srv_not_configured", message: "Servicio no configurado.", retriable: true }, 503);
    }

    // Cliente anon SOLO para validar el usuario (JWT); las mutaciones y
    // lecturas administrativas van por service_role.
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return json({ ok: false, code: "unauthorized", message: "Autenticación requerida.", retriable: false }, 401);
    }

    // 2) Cliente service_role: rol del actor + operaciones de datos.
    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 3) Política de administrador (server-side, nunca del payload).
    const profile = await fetchProfile(serviceClient, user.id);
    const policy = requireAdmin(profile);
    if (!policy.allowed) {
      return json(
        { ok: false, code: policy.error.code, message: policy.error.message, retriable: false },
        policy.error.status
      );
    }

    // 4) Cuerpo + acción.
    const parsed = await parseJson(req);
    if (!parsed.ok) {
      return json({ ok: false, code: parsed.error.code, message: parsed.error.message, retriable: false }, 400);
    }
    const body = parsed.data;

    const actionCheck = validateAction(body?.action);
    if (!actionCheck.ok) {
      return json(
        { ok: false, code: actionCheck.error.code, message: actionCheck.error.message, retriable: false },
        actionCheck.error.status
      );
    }

    // 5) Despacho.
    switch (body.action) {
      case "create": {
        const check = validateCreateEmployee(body);
        if (!check.ok) {
          return json(
            { ok: false, code: check.error.code, message: check.error.message, retriable: false },
            check.error.status
          );
        }
        const result = await createEmployee({ auth: supabase, serviceClient, data: check.data });
        return json(result.body, result.status);
      }
      case "list": {
        const result = await listEmployees({ supabase, serviceClient });
        return json(result.body, result.status);
      }
      case "update": {
        const check = validateUpdateEmployee(body);
        if (!check.ok) {
          return json(
            { ok: false, code: check.error.code, message: check.error.message, retriable: false },
            check.error.status
          );
        }
        const result = await updateEmployee({ auth: supabase, serviceClient, data: check.data });
        return json(result.body, result.status);
      }
      default:
        return json(
          { ok: false, code: "invalid_action", message: "Acción no válida.", retriable: false },
          400
        );
    }
  } catch {
    return json({ ok: false, code: "internal_error", message: "Error interno de la operación.", retriable: true }, 500);
  }
});