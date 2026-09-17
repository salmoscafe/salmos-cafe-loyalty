import React, { useState } from "react";
import { authService } from "../../services/index.js";
import { Wordmark } from "../common/BrandMark.jsx";
import { PrimaryButton, Field } from "../common/ui.jsx";

// ---------------------------------------------------------------
// RoleLoginScreen — acceso por rol (staff | admin), UN solo
// mecanismo de sesión (Supabase Auth). Para eventos de demo sin
// Supabase configurado usa el PIN del mock.
//
// Flujo real:
//   email + contraseña → Supabase Auth → getProfile()
//   profile.role ∈ (allowedRoles ?? [requiredRole]) && profile.active → onSignedIn
//   Cualquier otra cosa → denegado.
//
// Flujo demo (authService.isDemoMode):
//   PIN → mockAuthService.signInStaff() → staffProfiles (solo requiredRole)
// ---------------------------------------------------------------
export function RoleLoginScreen({ requiredRole, allowedRoles, title, subtitle, demoHint, onSignedIn }) {
  // Roles aceptados en modo REAL. Por defecto, solo `requiredRole`.
  // El modo demo conserva `requiredRole` (los PIN mock no cambian).
  const realRoles = Array.isArray(allowedRoles) && allowedRoles.length ? allowedRoles : [requiredRole];

  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleDemoSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await authService.signInStaff({ pin });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.staff.role !== requiredRole) {
      setError("No tienes permisos para entrar a esta sección.");
      return;
    }
    onSignedIn({ id: res.staff.id, name: res.staff.name, role: res.staff.role });
  }

  async function handleRealSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const login = await authService.signInWithPassword({ identifier: email.trim(), password });
    if (!login.ok) {
      setLoading(false);
      setError(login.error?.message || "No pudimos iniciar sesión.");
      return;
    }
    const profile = await authService.getProfile();
    setLoading(false);
    if (!profile) {
      setError("No encontramos tu perfil de acceso.");
      return;
    }
    if (!profile.active) {
      setError("Tu cuenta está desactivada. Contacta a un administrador.");
      return;
    }
    if (!realRoles.includes(profile.role)) {
      setError(`Este acceso es para el rol ${realRoles.join(" o ")}. Tu cuenta no está autorizada.`);
      return;
    }
    onSignedIn({ id: profile.id, name: profile.name || email.split("@")[0], role: profile.role });
  }

  return (
    <div className="sc-screen sc-login">
      <Wordmark on="cream" className="sc-login__wordmark" />
      <h1 className="sc-hero-title">{title}</h1>
      <p className="sc-login__sub">{subtitle}</p>

      {authService.isDemoMode ? (
        <form onSubmit={handleDemoSubmit} className="sc-login__form">
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
          <p className="sc-login__demo-hint">{demoHint}</p>
        </form>
      ) : (
        <form onSubmit={handleRealSubmit} className="sc-login__form">
          <Field label="Correo">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@email.com"
              className="sc-input"
              autoFocus
            />
          </Field>
          <Field label="Contraseña">
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="sc-input"
            />
          </Field>
          {error && <p className="sc-login__error">{error}</p>}
          <PrimaryButton type="submit" disabled={loading}>
            {loading ? "Entrando…" : "Entrar"}
          </PrimaryButton>
        </form>
      )}
    </div>
  );
}