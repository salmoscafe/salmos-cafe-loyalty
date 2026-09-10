import React from "react";
import { Icon } from "../../components/common/icons.jsx";

const ROWS = [
  { label: "Datos personales", note: "Nombre, teléfono" },
  { label: "Email", note: "Verificado" },
  { label: "Métodos de acceso", note: "Google, email, teléfono" },
  { label: "Notificaciones", note: "Próximamente" },
  { label: "Wallet", note: "Apple Wallet, Google Wallet" },
];

export function SettingsScreen({ onBack }) {
  return (
    <div className="sc-screen">
      <button className="sc-back-link" onClick={onBack}>
        <Icon.ArrowLeft className="sc-icon-sm" /> Perfil
      </button>
      <h1 className="sc-screen-title">Configuración</h1>

      <ul className="sc-list">
        {ROWS.map((row) => (
          <li key={row.label} className="sc-list__item sc-list__item--link">
            <span className="sc-list__body">
              <span className="sc-list__title">{row.label}</span>
              <span className="sc-list__meta">{row.note}</span>
            </span>
            <Icon.ChevronRight className="sc-icon-sm" />
          </li>
        ))}
      </ul>
      <p className="sc-hint">Estas secciones son de solo lectura por ahora — se conectan en una fase posterior.</p>
    </div>
  );
}
