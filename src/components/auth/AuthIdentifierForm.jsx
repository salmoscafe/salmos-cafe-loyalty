import React, { useState } from "react";
import { AuthMethodSelector } from "./AuthMethodSelector.jsx";
import { AuthMessage } from "./AuthMessage.jsx";
import { Field, PrimaryButton, SecondaryButton } from "../common/ui.jsx";
import { authService } from "../../services/index.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValid(method, value) {
  if (method === "email") return EMAIL_RE.test(value.trim());
  return value.replace(/\D/g, "").length === 10;
}

export function AuthIdentifierForm({ onIdentified, onGoogle, error, loading, onDismissError }) {
  const [method, setMethod] = useState("email");
  const [value, setValue] = useState("");

  const valid = isValid(method, value);

  function handleMethodChange(next) {
    setMethod(next);
    setValue("");
    onDismissError();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!valid || loading) return;
    const fullValue = method === "phone" ? `+52 ${value.replace(/\D/g, "")}` : value.trim();
    onIdentified({ method, value: fullValue });
  }

  function applyPreset(presetMethod, presetValue) {
    setMethod(presetMethod);
    setValue(presetValue);
    onDismissError();
  }

  return (
    <div className="sc-auth-identify">
      <p className="sc-eyebrow-plain">Bienvenido a Salmos Café</p>
      <h1 className="sc-hero-title">Entra a tu tarjeta</h1>
      <p className="sc-login__sub">Inicia sesión o crea tu cuenta en un momento.</p>

      <AuthMethodSelector method={method} onChange={handleMethodChange} />

      <form onSubmit={handleSubmit} className="sc-login__form">
        {method === "email" ? (
          <Field label="Correo electrónico">
            <input
              type="email"
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="tucorreo@ejemplo.com"
              className="sc-input"
              autoFocus
            />
          </Field>
        ) : (
          <Field label="Teléfono">
            <div className="sc-phone-input">
              <span className="sc-phone-input__prefix">🇲🇽 +52</span>
              <input
                type="tel"
                inputMode="numeric"
                required
                value={value}
                onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 10))}
                placeholder="664 123 4567"
                className="sc-input sc-phone-input__field"
              />
            </div>
          </Field>
        )}

        {error === "transient" && (
          <AuthMessage tone="error" action={{ label: "Reintentar", onClick: handleSubmit }}>
            Algo salió mal. Intenta de nuevo.
          </AuthMessage>
        )}

        <PrimaryButton type="submit" disabled={!valid || loading}>
          {loading ? "Un momento…" : "Continuar"}
        </PrimaryButton>
      </form>

      <div className="sc-auth-divider"><span>o</span></div>

      <SecondaryButton type="button" onClick={onGoogle} disabled={loading}>
        Continuar con Google
      </SecondaryButton>

      {authService.isDemoMode && (
        <div className="sc-demo-box">
          <p className="sc-demo-box__label">Modo de prueba (solo para esta demo)</p>
          <div className="sc-demo-box__pills">
            <button type="button" className="sc-pill" onClick={() => applyPreset("email", "javier@example.com")}>
              Cliente existente
            </button>
            <button type="button" className="sc-pill" onClick={() => applyPreset("email", `nuevo.${Date.now()}@example.com`)}>
              Cliente nuevo
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
