import React from "react";
import { Icon } from "../common/icons.jsx";
import { IconMark } from "../common/BrandMark.jsx";
import { QrCode } from "./QrCode.jsx";
import { SecondaryButton } from "../common/ui.jsx";

export function QrModal({ open, onClose, cardNumber, customerName, mode = "show" }) {
  if (!open) return null;
  const title =
    mode === "redeem"
      ? "Muéstrale este código al equipo para canjear tu recompensa"
      : "Muéstrale este código al equipo de Salmos Café";

  return (
    <div className="sc-modal-overlay" onClick={onClose}>
      <div className="sc-modal" onClick={(e) => e.stopPropagation()}>
        <button className="sc-modal__close" onClick={onClose} aria-label="Cerrar">
          <Icon.Close className="sc-icon" />
        </button>
        <IconMark on="cream" className="sc-modal__mark" />
        <p className="sc-modal__title">{title}</p>
        <QrCode token={cardNumber} />
        <p className="sc-modal__card-number">{cardNumber}</p>
        <p className="sc-modal__hint">{customerName}</p>
        <SecondaryButton onClick={onClose}>Cerrar</SecondaryButton>
      </div>
    </div>
  );
}
