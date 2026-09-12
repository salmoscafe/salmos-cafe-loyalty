import React from "react";

export function Spinner({ label }) {
  return (
    <div className="sc-spinner-wrap" role="status" aria-live="polite">
      <span className="sc-spinner" />
      {label && <span className="sc-spinner-label">{label}</span>}
    </div>
  );
}

export function EmptyState({ title, hint }) {
  return (
    <div className="sc-empty-state">
      <p className="sc-empty-state__title">{title}</p>
      {hint && <p className="sc-empty-state__hint">{hint}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }) {
  return (
    <div className="sc-error-state">
      <p>{message}</p>
      {onRetry && (
        <button className="sc-btn-secondary" onClick={onRetry}>
          Reintentar
        </button>
      )}
    </div>
  );
}

export function PrimaryButton({ children, ...props }) {
  return (
    <button className="sc-btn-primary" {...props}>
      {children}
    </button>
  );
}

export function SecondaryButton({ icon, children, ...props }) {
  return (
    <button className="sc-btn-secondary" {...props}>
      {icon && <span className="sc-btn-secondary__icon" aria-hidden="true">{icon}</span>}
      {children}
    </button>
  );
}

export function Field({ label, children }) {
  return (
    <label className="sc-field">
      <span className="sc-field__label">{label}</span>
      {children}
    </label>
  );
}
