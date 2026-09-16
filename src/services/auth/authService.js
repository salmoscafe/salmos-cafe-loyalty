// ---------------------------------------------------------------
// authService — FACADE. Mismo contrato público que la UI consume
// (AuthScreen y compañía), con dos implementaciones intercambiables:
//
//   * Sin Supabase configurado → MOCK en memoria (modo demo/dev).
//   * Con VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY → implementación
//     real sobre Supabase Auth (`./auth/supabaseAuthService.js`).
//
// Contrato (igual en ambas):
//   * signUpWithEmail / signInWithPassword  ← contraseña como auth principal
//       (identificador = correo o teléfono).
//   * forgotPasswordStart/Verify/Resend + setNewPassword ← OTP SOLO como
//       recuperación de contraseña.
//   * signInWithGoogle ← OAuth (el resultado llega vía redirect/sesión).
//   * checkSecondaryContact / resendConfirmationEmail.
//   * Sesión: getSession / onSessionChange / signOutClient / retryLoyverseSync.
//
// Staff y Admin siguen siendo mock en esta fase (su auth real es un
// paso posterior), sin importar el modo — por eso se delega siempre a
// la implementación mock.
// ---------------------------------------------------------------

import * as mock from "./mockAuthService.js";
import * as real from "./supabaseAuthService.js";
import { isSupabaseConfigured } from "../../lib/supabase/client.js";

export const isDemoMode = !isSupabaseConfigured;

const impl = isSupabaseConfigured ? real : mock;

const pick = (name) =>
  typeof impl[name] === "function" ? impl[name].bind(impl) : mock[name].bind(mock);

// --- Cliente (Supabase real o mock) ------------------------------------
export const getSession = pick("getSession");
export const onSessionChange = pick("onSessionChange");
export const signOutClient = pick("signOutClient");
export const retryLoyverseSync = pick("retryLoyverseSync");

export const signUpWithEmail = pick("signUpWithEmail");
export const signInWithPassword = pick("signInWithPassword");
export const checkSecondaryContact = pick("checkSecondaryContact");
export const resendConfirmationEmail = pick("resendConfirmationEmail");

export const forgotPasswordStart = pick("forgotPasswordStart");
export const forgotPasswordVerify = pick("forgotPasswordVerify");
export const forgotPasswordResend = pick("forgotPasswordResend");
export const setNewPassword = pick("setNewPassword");
export const cancelPending = pick("cancelPending"); // síncrono, idéntico en ambos

export const signInWithGoogle = pick("signInWithGoogle");

// Dev flags — en modo real son no-ops; solo existen para la demo mock.
export const devSetForceTransientError = mock.devSetForceTransientError;
export const devSetGoogleMode = mock.devSetGoogleMode;

// --- Perfil de rol (profiles) -------------------------------------------
export const getProfile = pick("getProfile");

// --- Staff (siempre mock en esta fase) -----------------------------------
export const getStaffSession = mock.getStaffSession;
export const signInStaff = mock.signInStaff;
export const signOutStaff = mock.signOutStaff;