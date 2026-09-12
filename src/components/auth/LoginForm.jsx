import React, { useState } from "react";
import { AuthMessage } from "./AuthMessage.jsx";
import { Field, PrimaryButton, SecondaryButton } from "../common/ui.jsx";
import { Icon } from "../common/icons.jsx";
import { authService } from "../../services/index.js";

// Formulario de inicio de sesión: identificador (correo o teléfono) +
// contraseña. Es la entrada PRINCIPAL del producto (AUTH_UX_DESIGN).
export function LoginForm({ onLogin, onGoToRegister, onForgotPassword, onGoogle, onResendConfirmation, error, loading, onDismissError, initialIdentifier }) {
  const [identifier, setIdentifier] = useState(initialIdentifier || "");
  const [password, setPassword] = useState("");

  const canSubmit = identifier.trim().length > 0 && password.length > 0 && !loading;

  function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    onLogin({ identifier: identifier.trim(), password });
  }

  function handleResend() {
    onResendConfirmation(identifier.trim());
  }

  return (
    <div className="sc-auth-login">
      <h1 className="sc-hero-title">Bienvenido</h1>
      <p className="sc-login__sub">Entra a tu tarjeta</p>

      <form onSubmit={handleSubmit} className="sc-login__form">
        <Field label="Correo o teléfono">
          <input
            type="text"
            autoComplete="username"
            value={identifier}
            onChange={(e) => {
              setIdentifier(e.target.value);
              onDismissError();
            }}
            placeholder="tucorreo@ejemplo.com o 664 123 4567"
            className="sc-input"
            autoFocus
          />
        </Field>

        <Field label="Contraseña">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              onDismissError();
            }}
            placeholder="Tu contraseña"
            className="sc-input"
          />
        </Field>

        <div className="sc-auth-row">
          <button type="button" className="sc-auth-link" onClick={onForgotPassword}>
            ¿Olvidaste tu contraseña?
          </button>
        </div>

        {error && error.code !== "EMAIL_NOT_CONFIRMED" && (
          <AuthMessage tone="error">{error.message}</AuthMessage>
        )}

        {error && error.code === "EMAIL_NOT_CONFIRMED" && (
          <AuthMessage tone="error" action={{ label: "Reenviar correo", onClick: handleResend }}>
            {error.message}
          </AuthMessage>
        )}

        <PrimaryButton type="submit" disabled={!canSubmit}>
          {loading ? "Entrando…" : "Iniciar sesión"}
        </PrimaryButton>
      </form>

      <p className="sc-auth-switch">
        ¿No tienes cuenta?{" "}
        <button type="button" className="sc-auth-link" onClick={onGoToRegister}>
          Regístrate aquí
        </button>
      </p>

      <div className="sc-auth-divider"><span>o</span></div>

      <SecondaryButton type="button" onClick={onGoogle} disabled={loading} icon={<Icon.Google />}>
        Continuar con Google
      </SecondaryButton>

      {authService.isDemoMode && (
        <div className="sc-demo-box">
          <p className="sc-demo-box__label">Modo de prueba (solo para esta demo)</p>
          <div className="sc-demo-box__pills">
            <button
              type="button"
              className="sc-pill"
              onClick={() => {
                setIdentifier("javier@example.com");
                setPassword("demo1234");
                onDismissError();
              }}
            >
              Cuenta de prueba (correo)
            </button>
            <button
              type="button"
              className="sc-pill"
              onClick={() => {
                setIdentifier("+52 664 123 4567");
                setPassword("demo1234");
                onDismissError();
              }}
            >
              Cuenta de prueba (teléfono)
            </button>
            <button type="button" className="sc-pill" onClick={() => authService.devSetGoogleMode("existing")}>
              Google: existente
            </button>
            <button type="button" className="sc-pill" onClick={() => authService.devSetGoogleMode("new")}>
              Google: nuevo
            </button>
            <button type="button" className="sc-pill" onClick={() => authService.devSetForceTransientError()}>
              Simular error temporal
            </button>
          </div>
        </div>
      )}
    </div>
  );
}