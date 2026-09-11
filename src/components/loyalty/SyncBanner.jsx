import React, { useState } from "react";

// ---------------------------------------------------------------
// SyncBanner — aviso de sincronización Salmos⇄Loyverse.
// Solo se muestra en modo real cuando la cuenta quedó sin vincular
// (failed) o cuando hay un conflicto de identidad (conflict).
// En demo (mock) `loyverseSyncStatus` es undefined y no se pinta.
// ---------------------------------------------------------------
export function SyncBanner({ status, onRetry }) {
  const [busy, setBusy] = useState(false);

  if (status !== "failed" && status !== "conflict") return null;

  const isConflict = status === "conflict";

  async function handleRetry() {
    setBusy(true);
    try {
      await onRetry();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={"sc-sync-banner" + (isConflict ? " sc-sync-banner--conflict" : "")}>
      <div className="sc-sync-banner__body">
        <p className="sc-sync-banner__title">
          {isConflict ? "No pudimos vincular tu cuenta automáticamente" : "Falta conectar tu cuenta con la tienda"}
        </p>
        <p className="sc-sync-banner__msg">
          {isConflict
            ? "Tu correo o teléfono ya están vinculados a otro cliente. Ingresa con esa cuenta o recupera tu contraseña, y asegúrate de que tu correo y tu teléfono queden enlazados para conservar tus puntos."
            : "Puedes reintentarlo ahora o después; tus puntos no se pierden."}
        </p>
      </div>
      {!isConflict && (
        <button className="sc-sync-banner__btn" disabled={busy} onClick={handleRetry}>
          {busy ? "Reintentando…" : "Reintentar"}
        </button>
      )}
    </div>
  );
}