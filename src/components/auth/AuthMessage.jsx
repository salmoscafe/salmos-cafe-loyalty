import React from "react";

// Banner inline reutilizable para info/error/conflicto dentro de
// cualquier estado de AuthScreen. Nunca es una pantalla nueva.
export function AuthMessage({ tone = "info", children, action }) {
  return (
    <div className={`sc-auth-message sc-auth-message--${tone}`}>
      <p>{children}</p>
      {action && (
        <button type="button" className="sc-auth-message__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
