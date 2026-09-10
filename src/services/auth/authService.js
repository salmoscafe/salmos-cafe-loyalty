// ---------------------------------------------------------------
// authService — FACADE. Mismo contrato público que la UI ya consume
// (AuthScreen y compañía), con dos implementaciones intercambiables:
//
//   * Sin Supabase configurado → MOCK en memoria (modo demo/dev),
//     seed del proyecto original.
//   * Con VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY → implementación
//     real sobre Supabase Auth (`./auth/supabaseAuthService.js`).
//
// La UI nunca sabe cuál implementación está corriendo. Tampoco cambia
// el contrato: identifyAccount/requestCode/verifyCode/... son iguales
// en ambos casos.
//
// Staff y Admin siguen siendo mock en esta fase (su auth real es un
// paso posterior), sin importar el modo — por eso se delega siembre a
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
export const signOutClient = pick("signOutClient");
export const identifyAccount = pick("identifyAccount");
export const requestCode = pick("requestCode");
export const verifyCode = pick("verifyCode");
export const resendCode = pick("resendCode");
export const cancelPending = mock.cancelPending; // síncrono, idéntico en ambos
export const checkSecondaryContact = pick("checkSecondaryContact");
export const signInWithGoogle = pick("signInWithGoogle");
export const completeRegistration = pick("completeRegistration");
export const onSessionChange = pick("onSessionChange");
export const retryLoyverseSync = pick("retryLoyverseSync");

// Dev flags — en modo real son no-ops; solo existen para la demo mock.
export const devSetForceTransientError = mock.devSetForceTransientError;
export const devSetGoogleMode = mock.devSetGoogleMode;

// --- Staff (siempre mock en esta fase) -----------------------------------
export const getStaffSession = mock.getStaffSession;
export const signInStaff = mock.signInStaff;
export const signOutStaff = mock.signOutStaff;