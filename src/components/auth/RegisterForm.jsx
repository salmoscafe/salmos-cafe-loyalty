import React, { useState } from "react";
import { AuthMessage } from "./AuthMessage.jsx";
import { Field, PrimaryButton } from "../common/ui.jsx";
import { authService } from "../../services/index.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Registro con correo + contraseña (auth PRINCIPAL por contraseña).
// El teléfono es opcional y solo de contacto: avisos importantes de la
// tarjeta + sirve como alias para iniciar sesión después.
export function RegisterForm({ onRegister, onBack, loading, error, onDismissError }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [checkingPhone, setCheckingPhone] = useState(false);
  const [phoneConflict, setPhoneConflict] = useState(null); // string mensaje
  const [fieldError, setFieldError] = useState(null);

  function validate() {
    if (!name.trim()) return "Escribe tu nombre.";
    if (!EMAIL_RE.test(email.trim())) return "Escribe un correo válido.";
    if (password.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
    if (confirm !== password) return "Las contraseñas no coinciden.";
    if (phone.trim()) {
      const digits = phone.replace(/\D/g, "");
      if (digits.length !== 10) return "El teléfono debe tener 10 dígitos (p. ej. 664 123 4567).";
    }
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (loading || checkingPhone || phoneConflict) return;
    const invalid = validate();
    if (invalid) {
      setFieldError(invalid);
      return;
    }
    onRegister({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      password,
      phone: phone.trim() ? `+52 ${phone.replace(/\D/g, "")}` : "",
    });
  }

  async function handlePhoneBlur() {
    if (!phone.trim() || phoneConflict) return;
    setCheckingPhone(true);
    const res = await authService.checkSecondaryContact({ method: "phone", value: `+52 ${phone.replace(/\D/g, "")}` });
    setCheckingPhone(false);
    if (!res.ok) setPhoneConflict(res.error?.message || "Ese teléfono ya está en uso.");
  }

  function applyTestData() {
    const stamp = Date.now();
    setName("Cliente Demo");
    setEmail(`demo.${stamp}@example.com`);
    setPhone("");
    setPassword("demo1234");
    setConfirm("demo1234");
    setFieldError(null);
    setPhoneConflict(null);
  }

  return (
    <div className="sc-auth-register">
      <p className="sc-eyebrow-plain">Vamos a crear tu cuenta</p>
      <h1 className="sc-hero-title">Regístrate</h1>
      <p className="sc-login__sub">Tu correo y tu contraseña son la llave de tu tarjeta de fidelidad.</p>

      <form onSubmit={handleSubmit} className="sc-login__form">
        <Field label="Nombre">
          <input
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setFieldError(null);
            }}
            placeholder="Tu nombre"
            className="sc-input"
            autoFocus
          />
        </Field>

        <Field label="Correo electrónico">
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setFieldError(null);
            }}
            placeholder="tucorreo@ejemplo.com"
            className="sc-input"
          />
        </Field>

        <Field label="Teléfono (opcional)">
          <div className="sc-phone-input">
            <span className="sc-phone-input__prefix">🇲🇽 +52</span>
            <input
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value.replace(/\D/g, "").slice(0, 10));
                setPhoneConflict(null);
                setFieldError(null);
              }}
              onBlur={handlePhoneBlur}
              placeholder="664 123 4567"
              className="sc-input sc-phone-input__field"
            />
          </div>
          <span className="sc-field__hint">Lo usamos solo para avisos importantes de tu tarjeta. También te servirá para entrar.</span>
        </Field>

        <Field label="Contraseña">
          <input
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setFieldError(null);
            }}
            placeholder="Mínimo 8 caracteres"
            className="sc-input"
          />
        </Field>

        <Field label="Confirmar contraseña">
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setFieldError(null);
            }}
            placeholder="Repite tu contraseña"
            className="sc-input"
          />
        </Field>

        {fieldError && <AuthMessage tone="error">{fieldError}</AuthMessage>}
        {error && <AuthMessage tone="error">{error.message}</AuthMessage>}
        {phoneConflict && (
          <AuthMessage
            tone="error"
            action={{ label: "Ir a iniciar sesión", onClick: () => onBack(`+52 ${phone.replace(/\D/g, "")}`) }}
          >
            {phoneConflict}
          </AuthMessage>
        )}

        <PrimaryButton type="submit" disabled={!name.trim() || !email.trim() || !password || !confirm || checkingPhone || phoneConflict || loading}>
          {checkingPhone || loading ? "Un momento…" : "Crear mi cuenta"}
        </PrimaryButton>
      </form>

      <p className="sc-auth-switch">
        ¿Ya tienes cuenta?{" "}
        <button type="button" className="sc-auth-link" onClick={() => onBack(null)}>
          Inicia sesión
        </button>
      </p>

      {authService.isDemoMode && (
        <div className="sc-demo-box">
          <p className="sc-demo-box__label">Modo de prueba (solo para esta demo)</p>
          <div className="sc-demo-box__pills">
            <button type="button" className="sc-pill" onClick={applyTestData}>
              Rellenar con datos de prueba
            </button>
          </div>
        </div>
      )}
    </div>
  );
}