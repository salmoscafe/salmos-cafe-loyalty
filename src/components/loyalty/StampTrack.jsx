import React from "react";
import { ICON_NAVY } from "../../lib/brandAssets.js";

// Puramente visual. Ya no recibe onTapNext: el cliente no puede
// agregar sellos tocando la tarjeta — el único camino es que Staff
// registre una compra (ver services/salesService.registerSale).
export function StampTrack({ visits, required }) {
  const items = Array.from({ length: required }, (_, i) => i);
  return (
    <div className="sc-track" role="list" aria-label={`Progreso: ${visits} de ${required} visitas`}>
      {items.map((i) => {
        const filled = i < visits;
        const row = i < 5 ? 0 : 1;
        const posInRow = i % 5;
        const lift = row === 0 ? (posInRow % 2 === 0 ? 0 : -6) : posInRow % 2 === 0 ? 4 : -2;
        return (
          <span
            key={i}
            role="listitem"
            aria-label={filled ? `Sello ${i + 1} completado` : `Sello ${i + 1} pendiente`}
            className={"sc-stamp" + (filled ? " sc-stamp--filled" : "")}
            style={{ transform: `translateY(${lift}px)` }}
          >
            {filled ? <img src={ICON_NAVY} alt="" className="sc-stamp__icon" /> : <span className="sc-stamp__dot" />}
          </span>
        );
      })}
    </div>
  );
}
