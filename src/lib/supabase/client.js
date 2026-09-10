import { createClient } from "@supabase/supabase-js";
import { readEnv } from "../utils/env.js";

// ---------------------------------------------------------------
// Cliente Supabase aislado. ES LA ÚNICA creación del cliente en el
// frontend. VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY son credenciales
// PÚBLICAS (diseñadas para el lado cliente). Jamás importar aquí una
// service_role key ni tokens administrativos.
//
// Si no hay variables de entorno, `supabaseClient` es null y la app
// corre en modo demo con el mock (authService.js enruta en consecuencia).
// ---------------------------------------------------------------

const supabaseUrl = readEnv("VITE_SUPABASE_URL");
const supabaseAnonKey = readEnv("VITE_SUPABASE_ANON_KEY");

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabaseClient = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;