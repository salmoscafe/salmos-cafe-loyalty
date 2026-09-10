import React, { useState } from "react";
import { Wordmark } from "../common/BrandMark.jsx";
import { AuthIdentifierForm } from "./AuthIdentifierForm.jsx";
import { OtpVerification } from "./OtpVerification.jsx";
import { NewAccountForm } from "./NewAccountForm.jsx";
import { GoogleConfirmation } from "./GoogleConfirmation.jsx";
import { ProvisioningState } from "./ProvisioningState.jsx";
import { authService } from "../../services/index.js";

// ---------------------------------------------------------------
// AuthScreen — un solo layout, una máquina de estados explícita.
// Reemplaza a LoginScreen. Ver AUTH_UX_DESIGN.md para el flujo
// completo; este componente es su implementación literal.
//
// Estados: identify | existing_verify | new_details | new_verify |
//          google_confirm | provisioning
// ---------------------------------------------------------------
export function AuthScreen({ onSignedIn, sessionExpired }) {
  const [authState, setAuthState] = useState("identify");
  const [loading, setLoading] = useState(false);
  const [identifyError, setIdentifyError] = useState(null);
  const [newDetailsError, setNewDetailsError] = useState(null);
  const [contact, setContact] = useState(null); // { method, value, maskedContact }
  const [newAccountDraft, setNewAccountDraft] = useState(null); // { name, secondaryContact }
  const [googleProfile, setGoogleProfile] = useState(null);
  const [googleDraft, setGoogleDraft] = useState(null); // { name, secondaryContact } — para poder reintentar sin perder lo que el usuario escribió
  const [provisioningStatus, setProvisioningStatus] = useState("working");
  const [notice, setNotice] = useState(
    sessionExpired ? "Tu sesión terminó, vuelve a entrar." : null
  );

  function resetToIdentify() {
    authService.cancelPending();
    setAuthState("identify");
    setContact(null);
    setNewAccountDraft(null);
    setGoogleProfile(null);
    setGoogleDraft(null);
    setIdentifyError(null);
    setNewDetailsError(null);
  }

  // --- identify ---------------------------------------------------------
  async function handleIdentified({ method, value }) {
    setLoading(true);
    setIdentifyError(null);
    setNotice(null);
    setGoogleProfile(null);
    setGoogleDraft(null);

    const res = await authService.identifyAccount({ method, value });
    if (!res.ok) {
      setLoading(false);
      setIdentifyError(res.error);
      return;
    }
    setContact(res);

    if (res.status === "existing") {
      const codeRes = await authService.requestCode({ method, value, forNewAccount: false });
      setLoading(false);
      if (!codeRes.ok) {
        setIdentifyError(codeRes.error);
        return;
      }
      setAuthState("existing_verify");
    } else {
      setLoading(false);
      setAuthState("new_details");
    }
  }

  async function handleGoogle() {
    setLoading(true);
    setIdentifyError(null);
    setNotice(null);
    setNewAccountDraft(null);
    setContact(null);
    const res = await authService.signInWithGoogle();
    setLoading(false);
    if (!res.ok) {
      setIdentifyError(res.error);
      return;
    }
    if (res.status === "existing") {
      onSignedIn();
      return;
    }
    setGoogleProfile(res.googleProfile);
    setAuthState("google_confirm");
  }

  // --- new_details --------------------------------------------------------
  async function handleNewDetailsContinue({ name, secondaryContact }) {
    setNewAccountDraft({ name, secondaryContact });
    setLoading(true);
    setNewDetailsError(null);
    const codeRes = await authService.requestCode({ method: contact.method, value: contact.value, forNewAccount: true });
    setLoading(false);
    if (!codeRes.ok) {
      setNewDetailsError(codeRes.error);
      return;
    }
    setAuthState("new_verify");
  }

  // --- conflicto: "entrar con ese contacto" desde new_details/google_confirm ---
  function handleResolveConflictAsLogin({ method, value }) {
    authService.cancelPending();
    setNewAccountDraft(null);
    setGoogleProfile(null);
    handleIdentified({ method, value });
  }

  // --- OTP (compartido por existing_verify y new_verify) ---
  async function handleVerify(code) {
    const res = await authService.verifyCode({ code });
    if (!res.ok) return res;

    if (res.mode === "existing") {
      onSignedIn();
      return res;
    }

    // Nuevo usuario verificado → crear cuenta.
    setAuthState("provisioning");
    setProvisioningStatus("working");
    const provRes = await authService.completeRegistration({
      name: newAccountDraft.name,
      secondaryContact: newAccountDraft.secondaryContact,
    });
    setProvisioningStatus(provRes.ok ? "working" : "error");
    if (provRes.ok) onSignedIn();
    return res;
  }

  async function handleResend() {
    await authService.resendCode();
  }

  // --- google_confirm -------------------------------------------------------
  async function handleGoogleConfirm({ name, secondaryContact }) {
    setGoogleDraft({ name, secondaryContact });
    setAuthState("provisioning");
    setProvisioningStatus("working");
    const res = await authService.completeRegistration({ name, secondaryContact, googleProfile });
    setProvisioningStatus(res.ok ? "working" : "error");
    if (res.ok) onSignedIn();
  }

  // --- provisioning: reintentar ---
  function handleRetryProvisioning() {
    if (googleDraft) {
      handleGoogleConfirm(googleDraft);
    } else if (newAccountDraft) {
      setProvisioningStatus("working");
      authService
        .completeRegistration({ name: newAccountDraft.name, secondaryContact: newAccountDraft.secondaryContact })
        .then((res) => {
          setProvisioningStatus(res.ok ? "working" : "error");
          if (res.ok) onSignedIn();
        });
    }
  }

  return (
    <div className="sc-screen sc-auth">
      {authState !== "provisioning" && <Wordmark on="cream" className="sc-login__wordmark" />}
      {notice && <p className="sc-auth-notice">{notice}</p>}

      {authState === "identify" && (
        <AuthIdentifierForm
          onIdentified={handleIdentified}
          onGoogle={handleGoogle}
          error={identifyError}
          loading={loading}
          onDismissError={() => setIdentifyError(null)}
        />
      )}

      {authState === "existing_verify" && (
        <OtpVerification
          title="Ya tienes una cuenta en Salmos."
          maskedContact={contact.maskedContact}
          onVerify={handleVerify}
          onResend={handleResend}
          onUseAnotherMethod={resetToIdentify}
        />
      )}

      {authState === "new_details" && (
        <NewAccountForm
          primaryMethod={contact.method}
          primaryValue={contact.value}
          onContinue={handleNewDetailsContinue}
          onResolveConflictAsLogin={handleResolveConflictAsLogin}
          loading={loading}
          transientError={newDetailsError}
        />
      )}

      {authState === "new_verify" && (
        <OtpVerification
          title="Confirma tu cuenta"
          subtitle={`Confirma tu ${contact.method === "email" ? "correo" : "teléfono"} para terminar — enviamos un código a ${contact.maskedContact}`}
          maskedContact={contact.maskedContact}
          onVerify={handleVerify}
          onResend={handleResend}
          onUseAnotherMethod={resetToIdentify}
        />
      )}

      {authState === "google_confirm" && (
        <GoogleConfirmation
          googleProfile={googleProfile}
          onConfirm={handleGoogleConfirm}
          onResolveConflictAsLogin={handleResolveConflictAsLogin}
          loading={loading}
        />
      )}

      {authState === "provisioning" && (
        <ProvisioningState status={provisioningStatus} onRetry={handleRetryProvisioning} />
      )}
    </div>
  );
}
