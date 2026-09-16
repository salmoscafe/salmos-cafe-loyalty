import React from "react";
import { RoleLoginScreen } from "../../components/auth/RoleLoginScreen.jsx";

// ---------------------------------------------------------------
// StaffLoginScreen — acceso del equipo (rol staff).
// Delega en RoleLoginScreen: email+contraseña en modo real,
// PIN en modo demo. Verifica role === 'staff' && active === true.
// ---------------------------------------------------------------
export function StaffLoginScreen({ onSignedIn }) {
  return (
    <RoleLoginScreen
      requiredRole="staff"
      title="Acceso de equipo"
      subtitle="Ingresa tus datos para escanear clientes y registrar ventas."
      demoHint="Demo: PIN 1234 (Ana) o 5678 (Marco)"
      onSignedIn={onSignedIn}
    />
  );
}