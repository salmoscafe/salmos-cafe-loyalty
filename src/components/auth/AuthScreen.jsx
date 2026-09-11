import React, { useState } from "react";
import { Wordmark } from "../common/BrandMark.jsx";
import { LoginForm } from "./LoginForm.jsx";
import { RegisterForm } from "./RegisterForm.jsx";
import { ResetForm } from "./ResetForm.jsx";
import { OtpVerification } from "./OtpVerification.jsx";
import { NewPasswordForm } from "./NewPasswordForm.jsx";
import { ProvisioningState } from "./ProvisioningState.jsx";
import { authService } from "../../services/index.js";
import { makeError } from "../../services/auth/authErrors.js";

// ---------------------------------------------------------------
// AuthScreen — un solo layout, una máquina de estados explícita.
// Ver AUTH_UX_DESIGN.md para el flujo completo.
//
// Estados:
//   login            → correo/teléfono + contraseña (entrada principal)
//   register         → nombre + correo + contraseña (+ teléfono opcional)
//   reset_identifier → "¿Olvidaste tu contraseña?" (correo o teléfono)
//   reset_otp        → código enviado al correo (OTP solo como recuperación)
//   new_password     → contraseña nueva (tras verificar el código)
//   provisioning     → la sesión ya existe; App arma perfil + Loyverse
// ---------------------------------------------------------------
export function AuthScreen({ onSignedIn, sessionExpired }) {
  const [authState, setAuthState] = useState("login");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(sessionExpired ? "Tu sesión terminó, vuelve a entrar." : null);
  const [maskedContact, setMaskedContact] = useState(null);
  const [loginInitialIdentifier, setLoginInitialIdentifier] = useState(null);
  const [provisioningStatus, setProvisioningStatus] = useState("working");

  function resetToLogin(prefillIdentifier) {
    authService.cancelPending();
    setAuthState("login");
    setError(null);
    setNotice(null);
    setMaskedContact(null);
    setLoginInitialIdentifier(prefillIdentifier || null);
  }

  async function enterProvisioning(nextStateOnFailure, failureError) {
    setAuthState("provisioning");
    setProvisioningStatus("working");
    const provisioned = await onSignedIn();
    if (provisioned) return; // App ya montó la app de cliente.
    // La sesión no quedó lista: regresa al estado anterior sin quedarte pegado.
    setProvisioningStatus("error");
    setAuthState(nextStateOnFailure);
    setError(failureError || makeError("NETWORK_ERROR"));
  }

  // --- login ---------------------------------------------------------
  async function handleLogin({ identifier, password }) {
    setLoading(true);
    setError(null);
    setNotice(null);
    const res = await authService.signInWithPassword({ identifier, password });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await enterProvisioning("login", null);
  }

  async function handleResendConfirmation(identifier) {
    setLoading(true);
    await authService.resendConfirmationEmail({ email: identifier });
    setLoading(false);
    setError(null);
    setNotice("Te reenviamos el correo de confirmación. Revisa tu bandeja de entrada.");
  }

  // --- register -------------------------------------------------------
  async function handleRegister(details) {
    setLoading(true);
    setError(null);
    setNotice(null);
    const res = await authService.signUpWithEmail(details);
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.mode === "confirm_email") {
      setNotice("Revisa tu correo: te enviamos un enlace para confirmar tu cuenta. Después ya podrás iniciar sesión.");
      setAuthState("login");
      return;
    }
    await enterProvisioning("login", null);
  }

  // --- google ----------------------------------------------------------
  async function handleGoogle() {
    setLoading(true);
    setError(null);
    setNotice(null);
    const res = await authService.signInWithGoogle();
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // En modo real el navegador redirige a Google; la sesión llega sola por
    // onSessionChange/detectSessionInUrl. En demo el mock ya dejó la sesión.
    if (authService.isDemoMode) {
      await enterProvisioning("login", null);
    }
  }

  // --- reset (recuperación de contraseña por OTP al correo) -----------
  async function handleResetStart({ identifier }) {
    setLoading(true);
    setError(null);
    const res = await authService.forgotPasswordStart({ identifier });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMaskedContact(res.maskedContact);
    setAuthState("reset_otp");
  }

  async function handleResetVerify(code) {
    const res = await authService.forgotPasswordVerify({ code });
    if (!res.ok) return res;
    setMaskedContact(null);
    setAuthState("new_password");
    return res;
  }

  async function handleResetResend() {
    await authService.forgotPasswordResend();
  }

  async function handleSetNewPassword({ newPassword }) {
    setLoading(true);
    setError(null);
    const res = await authService.setNewPassword({ newPassword });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    resetToLogin(null);
    setNotice("Contraseña actualizada. Entra con tu contraseña nueva.");
  }

  // --- provisioning: reintentar ---------------------------------------
  function handleRetryProvisioning() {
    enterProvisioning("login", null);
  }

  return (
    <div className="sc-screen sc-auth">
      {authState !== "provisioning" && <Wordmark on="cream" className="sc-login__wordmark" />}
      {notice && <p className="sc-auth-notice">{notice}</p>}

      {authState === "login" && (
        <LoginForm
          key={loginInitialIdentifier || "login"}
          initialIdentifier={loginInitialIdentifier || undefined}
          onLogin={handleLogin}
          onGoToRegister={() => {
            authService.cancelPending();
            setError(null);
            setAuthState("register");
          }}
          onForgotPassword={() => {
            setError(null);
            setAuthState("reset_identifier");
          }}
          onGoogle={handleGoogle}
          onResendConfirmation={handleResendConfirmation}
          error={error}
          loading={loading}
          onDismissError={() => setError(null)}
        />
      )}

      {authState === "register" && (
        <RegisterForm
          onRegister={handleRegister}
          onBack={(prefillIdentifier) => resetToLogin(prefillIdentifier)}
          error={error}
          loading={loading}
          onDismissError={() => setError(null)}
        />
      )}

      {authState === "reset_identifier" && (
        <ResetForm
          onStart={handleResetStart}
          onBack={() => resetToLogin(null)}
          error={error}
          loading={loading}
          onDismissError={() => setError(null)}
        />
      )}

      {authState === "reset_otp" && (
        <OtpVerification
          title="Recuperar contraseña"
          subtitle={`Enviamos un código a tu correo ${maskedContact || ""}`}
          onVerify={handleResetVerify}
          onResend={handleResetResend}
          onUseAnotherMethod={() => resetToLogin(null)}
        />
      )}

      {authState === "new_password" && (
        <NewPasswordForm
          onSubmit={handleSetNewPassword}
          onCancel={() => resetToLogin(null)}
          error={error}
          loading={loading}
          onDismissError={() => setError(null)}
        />
      )}

      {authState === "provisioning" && (
        <ProvisioningState status={provisioningStatus} onRetry={handleRetryProvisioning} />
      )}
    </div>
  );
}