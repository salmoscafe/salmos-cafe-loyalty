import React from "react";

export function AuthMethodSelector({ method, onChange }) {
  return (
    <div className="sc-auth-method-toggle" role="tablist" aria-label="Método de identificación">
      <button
        type="button"
        role="tab"
        aria-selected={method === "email"}
        className={"sc-auth-method-toggle__btn" + (method === "email" ? " sc-auth-method-toggle__btn--active" : "")}
        onClick={() => onChange("email")}
      >
        Correo
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={method === "phone"}
        className={"sc-auth-method-toggle__btn" + (method === "phone" ? " sc-auth-method-toggle__btn--active" : "")}
        onClick={() => onChange("phone")}
      >
        Teléfono
      </button>
    </div>
  );
}
