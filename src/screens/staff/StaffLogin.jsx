import React, { useState } from "react";
import { authService } from "../../services/index.js";
import { Wordmark } from "../../components/common/BrandMark.jsx";
import { PrimaryButton, Field } from "../../components/common/ui.jsx";

export function StaffLoginScreen({ onSignedIn }) {
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await authService.signInStaff({ pin });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSignedIn(res.staff);
  }

  return (
    <div className="sc-screen sc-login">
      <Wordmark on="cream" className="sc-login__wordmark" />
      <h1 className="sc-hero-title">Acceso de equipo</h1>
      <p className="sc-login__sub">Ingresa tu PIN para escanear clientes y registrar ventas.</p>

      <form onSubmit={handleSubmit} className="sc-login__form">
        <Field label="PIN">
          <input
            type="password"
            inputMode="numeric"
            required
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
            className="sc-input"
          />
        </Field>
        {error && <p className="sc-login__error">{error}</p>}
        <PrimaryButton type="submit" disabled={loading}>
          {loading ? "Entrando…" : "Entrar"}
        </PrimaryButton>
      </form>
      <p className="sc-login__demo-hint">Demo: PIN 1234 (Ana) o 5678 (Marco)</p>
    </div>
  );
}
