import React from "react";
import { Icon } from "../common/icons.jsx";

export function BottomNav({ screen, onNavigate, onQr }) {
  const items = [
    { key: "home", label: "Inicio", Icon: Icon.Home },
    { key: "rewards", label: "Recompensas", Icon: Icon.Gift },
    { key: "activity", label: "Actividad", Icon: Icon.Activity },
    { key: "profile", label: "Perfil", Icon: Icon.User },
  ];
  return (
    <nav className="sc-nav">
      {items.slice(0, 2).map((it) => (
        <button
          key={it.key}
          className={"sc-nav__item" + (screen === it.key ? " sc-nav__item--active" : "")}
          onClick={() => onNavigate(it.key)}
        >
          <it.Icon className="sc-icon" />
          <span>{it.label}</span>
        </button>
      ))}

      <button className="sc-nav__qr" onClick={onQr} aria-label="Mostrar mi QR">
        <Icon.QR className="sc-icon" />
      </button>

      {items.slice(2).map((it) => (
        <button
          key={it.key}
          className={"sc-nav__item" + (screen === it.key ? " sc-nav__item--active" : "")}
          onClick={() => onNavigate(it.key)}
        >
          <it.Icon className="sc-icon" />
          <span>{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
