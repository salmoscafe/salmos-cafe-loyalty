import React, { useState } from "react";
import { AuthMessage } from "./AuthMessage.jsx";
import { Field, PrimaryButton } from "../common/ui.jsx";

// Paso final de la recuperación: la contraseña nueva. Solo se llega aquí
// después de verificar el código OTP (los servicios exigen ese orden).
export function NewPasswordForm({ onSubmit, onCancel, loading, error, onDismissError }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldError, setFieldError] = useState(null);

  function handleSubmit(e) {
    e.preventDefault();
    if (loading) return;
    if (password.length < 8) {
      setFieldError("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (confirm !== password) {
      setFieldError("Las contraseñas no coinciden.");
      return;
    }
    setFieldError(null);
    onSubmit({ newPassword: password });
  }

  return (
    <div className="sc-auth-new-password">
      <p className="sc-eyebrow-plain">Recuperar contraseña</p>
      <h1 className="sc-hero-title">Crea tu contraseña nueva</h1>
      <p className="sc-login__sub">Úsala la próxima vez que quieras entrar.</p>

      <form onSubmit={handleSubmit} className="sc-login__form">
        <Field label="Contraseña nueva">
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setFieldError(null);
              onDismissError();
            }}
            placeholder="Mínimo 8 caracteres"
            className="sc-input"
            autoFocus
          />
        </Field>

        <Field label="Confirmar contraseña">
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setFieldError(null);
              onDismissError();
            }}
            placeholder="Repite tu contraseña"
            className="sc-input"
          />
        </Field>

        {fieldError && <AuthMessage tone="error">{fieldError}</AuthMessage>}
        {error && <AuthMessage tone="error">{error.message}</AuthMessage>}

        <PrimaryButton type="submit" disabled={!password || !confirm || loading}>
          {loading ? "Guardando…" : "Guardar contraseña"}
        </PrimaryButton>
      </form>

      <p className="sc-auth-switch">
        <button type="button" className="sc-auth-link" onClick={onCancel}>
          Cancelar recuperación
        </button>
      </p>
    </div>
  );
}