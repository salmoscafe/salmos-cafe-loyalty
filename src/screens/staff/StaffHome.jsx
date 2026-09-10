import React from "react";
import { Icon } from "../../components/common/icons.jsx";

export function StaffHomeScreen({ staff, onScan, onActivity, onSignOut }) {
  return (
    <div className="sc-screen sc-staff-home">
      <div className="sc-staff-head">
        <p className="sc-eyebrow-plain">Equipo Salmos Café</p>
        <h1 className="sc-hero-title">Hola, {staff.name.split(" ")[0]}</h1>
      </div>

      <button className="sc-staff-tile sc-staff-tile--primary" onClick={onScan}>
        <Icon.Scan className="sc-icon-lg" />
        <span>Escanear cliente</span>
      </button>

      <button className="sc-staff-tile" onClick={onScan}>
        <Icon.Receipt className="sc-icon-lg" />
        <span>Registrar venta</span>
      </button>

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
