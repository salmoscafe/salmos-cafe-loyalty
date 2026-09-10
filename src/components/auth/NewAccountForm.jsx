import React, { useState } from "react";
import { AuthMessage } from "./AuthMessage.jsx";
import { Field, PrimaryButton } from "../common/ui.jsx";
import { authService } from "../../services/index.js";

export function NewAccountForm({ primaryMethod, primaryValue, onContinue, onResolveConflictAsLogin, loading, transientError }) {
  const [name, setName] = useState("");
  const [secondaryValue, setSecondaryValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [conflict, setConflict] = useState(null);

  const secondaryMethod = primaryMethod === "email" ? "phone" : "email";
  const secondaryLabel =
    secondaryMethod === "phone" ? "Teléfono (opcional)" : "Correo (opcional)";

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim() || checking || loading) return;

    const trimmedSecondary = secondaryValue.trim();
    if (!trimmedSecondary) {
      onContinue({ name: name.trim(), secondaryContact: null });
      return;
    }

    setChecking(true);
    setConflict(null);
    const value =
      secondaryMethod === "phone" && !trimmedSecondary.startsWith("+")
        ? `+52 ${trimmedSecondary.replace(/\D/g, "")}`
        : trimmedSecondary;
    const res = await authService.checkSecondaryContact({ method: secondaryMethod, value });
    setChecking(false);

    if (!res.ok) {
      setConflict({ method: secondaryMethod, value, message: res.message });
      return;
    }
    onContinue({ name: name.trim(), secondaryContact: { method: secondaryMethod, value } });
  }

  return (
    <div className="sc-auth-new-details">
      <p className="sc-eyebrow-plain">Vamos a crear tu cuenta</p>
      <h1 className="sc-hero-title">Cuéntanos quién eres</h1>
      <p className="sc-login__sub">
        Creando cuenta para <strong>{primaryValue}</strong>
      </p>

      <form onSubmit={handleSubmit} className="sc-login__form">
        <Field label="Nombre">
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tu nombre"
            className="sc-input"
            autoFocus
          />
        </Field>

        <Field label={secondaryLabel}>
          <input
            type={secondaryMethod === "email" ? "email" : "tel"}
            value={secondaryValue}
            onChange={(e) => {
              setSecondaryValue(e.target.value);
              setConflict(null);
            }}
            placeholder={secondaryMethod === "phone" ? "664 123 4567" : "tucorreo@ejemplo.com"}
            className="sc-input"
          />
          <span className="sc-field__hint">Lo usamos solo para avisos importantes de tu tarjeta.</span>
        </Field>

        {conflict && (
          <AuthMessage
            tone="error"
            action={{
              label: `Entrar con ese ${conflict.method === "phone" ? "teléfono" : "correo"}`,
              onClick: () => onResolveConflictAsLogin({ method: conflict.method, value: conflict.value }),
            }}
          >
            {conflict.message}
          </AuthMessage>
        )}

        {transientError && !conflict && (
          <AuthMessage tone="error">Algo salió mal. Intenta de nuevo.</AuthMessage>
        )}

        <PrimaryButton type="submit" disabled={!name.trim() || checking || loading}>
          {checking || loading ? "Un momento…" : "Continuar"}
        </PrimaryButton>
      </form>
    </div>
  );
}
