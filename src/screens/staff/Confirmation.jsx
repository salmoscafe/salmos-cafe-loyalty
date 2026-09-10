import React from "react";
import { Icon } from "../../components/common/icons.jsx";
import { PrimaryButton, SecondaryButton } from "../../components/common/ui.jsx";
import { formatCurrency } from "../../lib/format.js";

export function ConfirmationScreen({ customer, sale, cycle, newReward, onRegisterAnother, onDone }) {
  return (
    <div className="sc-screen sc-confirmation">
      <div className="sc-confirmation__icon">
        <Icon.Check className="sc-icon-xl" />
      </div>
      <h1 className="sc-screen-title">¡Compra registrada!</h1>

      <div className="sc-info-card">
        <div className="sc-info-row"><span>Cliente</span><span>{customer.name}</span></div>
        <div className="sc-info-row"><span>Compra</span><span>{formatCurrency(sale.amount)}</span></div>
        <div className="sc-info-row"><span>Visita</span><span>+1</span></div>
        <div className="sc-info-row"><span>Nueva tarjeta</span><span>{cycle.visits}/{cycle.requiredVisits}</span></div>
      </div>

      {newReward && (
        <div className="sc-celebrate-inline">
          <Icon.Sparkle className="sc-icon" />
          <div>
            <p className="sc-celebrate-inline__title">¡Recompensa desbloqueada!</p>
            <p className="sc-celebrate-inline__sub">{newReward.label} · hasta {formatCurrency(newReward.maxValue)}</p>
          </div>
        </div>
      )}

      <PrimaryButton onClick={onRegisterAnother}>Registrar otra venta</PrimaryButton>
      <SecondaryButton onClick={onDone}>Terminar</SecondaryButton>
    </div>
  );
}
