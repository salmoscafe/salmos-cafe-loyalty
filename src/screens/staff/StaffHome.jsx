import React from "react";
import { Icon } from "../../components/common/icons.jsx";

// CHECKPOINT 3.2.1 — StaffHome refleja la arquitectura real:
//
//   * COMPRA NORMAL: ocurre DIRECTAMENTE en el POS de Loyverse
//     (identifica/asigna al cliente, ticket, productos, pago → receipt →
//     loyverse-receipts-sync → Salmos registra la visita). Salmos NO
//     escanea al cliente durante una compra.
//   * RECOMPENSA: el cliente muestra su QR y Salmos valida identidad y
//     recompensa (Claim/OTP/Redeem en un checkpoint posterior).
//
// El escaneo de Salmos existe SOLO para validaciones/recompensas. No hay
// ningún tile de "venta": vender se hace en Loyverse, no en Salmos.
export function StaffHomeScreen({ staff, onScan, onActivity, onSignOut }) {
  return (
    <div className="sc-screen sc-staff-home">
      <div className="sc-staff-head">
        <p className="sc-eyebrow-plain">Equipo Salmos Café</p>
        <h1 className="sc-hero-title">Hola, {staff.name.split(" ")[0]}</h1>
      </div>

      <button className="sc-staff-tile sc-staff-tile--primary" onClick={onScan}>
        <Icon.Scan className="sc-icon-lg" />
        <span>Validar recompensa</span>
      </button>

      <div className="sc-staff-note" role="note">
        <p className="sc-staff-note__title">Las ventas se registran directamente en Loyverse.</p>
        <p className="sc-staff-note__sub">Salmos registra tu visita automáticamente después de la compra.</p>
      </div>

      <button className="sc-staff-tile" onClick={onActivity}>
        <Icon.Activity className="sc-icon-lg" />
        <span>Actividad</span>
      </button>

      <button className="sc-signout" onClick={onSignOut}>
        Cerrar sesión
      </button>
    </div>
  );
}
