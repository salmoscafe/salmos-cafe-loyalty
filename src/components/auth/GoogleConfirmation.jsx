import React, { useState } from "react";
import { AuthMessage } from "./AuthMessage.jsx";
import { Field, PrimaryButton } from "../common/ui.jsx";
import { authService } from "../../services/index.js";

export function GoogleConfirmation({ googleProfile, onConfirm, onResolveConflictAsLogin, loading }) {
  const [name, setName] = useState(googleProfile.name);
  const [phone, setPhone] = useState("");
  const [checking, setChecking] = useState(false);
  const [conflict, setConflict] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim() || checking || loading) return;

    const trimmedPhone = phone.trim();
    if (!trimmedPhone) {
      onConfirm({ name: name.trim(), secondaryContact: null });
      return;
    }

    setChecking(true);
    setConflict(null);
    const value = `+52 ${trimmedPhone.replace(/\D/g, "")}`;
    const res = await authService.checkSecondaryContact({ method: "phone", value });
    setChecking(false);

    if (!res.ok) {
      setConflict({ method: "phone", value, message: res.message });
      return;
    }
    onConfirm({ name: name.trim(), secondaryContact: { method: "phone", value } });
  }

  return (
    <div className="sc-auth-new-details">
      <p className="sc-eyebrow-plain">Vamos a crear tu cuenta con estos datos de Google</p>
      <h1 className="sc-hero-title">Confirma tus datos</h1>

      <form onSubmit={handleSubmit} className="sc-login__form">
        <Field label="Nombre">
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="sc-input"
            autoFocus
          />
        </Field>

        <Field label="Correo">
          <input type="email" value={googleProfile.email} className="sc-input" disabled />
        </Field>

        <Field label="Teléfono (opcional)">
          <input
            type="tel"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setConflict(null);
            }}
            placeholder="664 123 4567"
            className="sc-input"
          />
          <span className="sc-field__hint">Lo usamos solo para avisos importantes de tu tarjeta.</span>
        </Field>

        {conflict && (
          <AuthMessage
            tone="error"
            action={{
              label: "Entrar con ese teléfono",
              onClick: () => onResolveConflictAsLogin({ method: conflict.method, value: conflict.value }),
            }}
          >
            {conflict.message}
          </AuthMessage>
        )}

        <PrimaryButton type="submit" disabled={!name.trim() || checking || loading}>
          {checking || loading ? "Un momento…" : "Confirmar y crear mi cuenta"}
        </PrimaryButton>
      </form>
    </div>
  );
}
