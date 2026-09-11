import React, { useState } from "react";
import { AuthMessage } from "./AuthMessage.jsx";
import { Field, PrimaryButton } from "../common/ui.jsx";
import { authService } from "../../services/index.js";

// Primer paso de la recuperación de contraseña: identificar la cuenta
// (correo o teléfono). El código siempre llega al correo: no hay proveedor
// SMS configurado en esta fase (ver AUTH_UX_DESIGN).
export function ResetForm({ onStart, onBack, loading, error, onDismissError }) {
  const [identifier, setIdentifier] = useState("");

  const canSubmit = identifier.trim().length > 0 && !loading;

  function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    onStart({ identifier: identifier.trim() });
  }

  return (
    <div className="sc-auth-reset">
      <p className="sc-eyebrow-plain">Recuperar contraseña</p>
      <h1 className="sc-hero-title">¿Olvidaste tu contraseña?</h1>
      <p className="sc-login__sub">
        Escribe el correo o teléfono de tu cuenta. Te enviaremos un código a tu correo para crear una contraseña nueva.
      </p>

      <form onSubmit={handleSubmit} className="sc-login__form">
        <Field label="Correo o teléfono">
          <input
            type="text"
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

        {error && <AuthMessage tone="error">{error.message}</AuthMessage>}

        <PrimaryButton type="submit" disabled={!canSubmit}>
          {loading ? "Enviando código…" : "Enviar código"}
        </PrimaryButton>
      </form>

      <p className="sc-auth-switch">
        <button type="button" className="sc-auth-link" onClick={() => onBack(null)}>
          Volver al inicio de sesión
        </button>
      </p>

      {authService.isDemoMode && (
        <div className="sc-demo-box">
          <p className="sc-demo-box__label">Modo de prueba (solo para esta demo)</p>
          <div className="sc-demo-box__pills">
            <button
              type="button"
              className="sc-pill"
              onClick={() => {
                setIdentifier("javier@example.com");
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
                onDismissError();
              }}
            >
              Cuenta de prueba (teléfono)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}