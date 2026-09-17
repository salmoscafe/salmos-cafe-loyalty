import React from "react";
import { RoleLoginScreen } from "../../components/auth/RoleLoginScreen.jsx";

// ---------------------------------------------------------------
// StaffLoginScreen — acceso del equipo (roles staff y admin en real).
// Delega en RoleLoginScreen: email+contraseña en modo real,
// PIN en modo demo. Verifica active === true y, en modo real,
// role ∈ { staff, admin }; la demo se mantiene solo con staff.
// ---------------------------------------------------------------
export function StaffLoginScreen({ onSignedIn }) {
  return (
    <RoleLoginScreen
      requiredRole="staff"
      allowedRoles={["staff", "admin"]}
      title="Acceso de equipo"
      subtitle="Ingresa tus datos para escanear clientes y registrar ventas."
      demoHint="Demo: PIN 1234 (Ana) o 5678 (Marco)"
      onSignedIn={onSignedIn}
    />
  );
}