import React, { useEffect, useState } from "react";
import { Icon } from "../../components/common/icons.jsx";
import { rewardService, REQUIRED_VISITS } from "../../services/index.js";
import { PrimaryButton, SecondaryButton, Spinner } from "../../components/common/ui.jsx";

export function CustomerFoundScreen({ customer, card, cycle, staff, onBack, onRegisterSale, onRedeemed }) {
  const [reward, setReward] = useState(undefined);
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    rewardService.getCurrentReward(card.id).then((r) => !cancelled && setReward(r));
    return () => {
      cancelled = true;
    };
  }, [card]);

  async function handleRedeem() {
    setRedeeming(true);
    setRedeemError(null);
    const res = await rewardService.redeemReward({ cardId: card.id, actorId: staff.id, actorRole: staff.role });
    setRedeeming(false);
    if (!res.ok) {
      setRedeemError(res.error);
      return;
    }
    onRedeemed(res);
  }

  const visits = cycle?.visits ?? 0;
  const required = cycle?.requiredVisits ?? REQUIRED_VISITS;

  return (
    <div className="sc-screen">
      <button className="sc-back-link" onClick={onBack}>
        <Icon.ArrowLeft className="sc-icon-sm" /> Escanear otro
      </button>

      <div className="sc-found-card">
        <div className="sc-avatar sc-avatar--lg">{customer.name.charAt(0)}</div>
        <p className="sc-found-name">{customer.name}</p>
        <p className="sc-found-number">{card.cardNumber}</p>
        <p className="sc-found-progress">{visits}/{required} visitas</p>
      </div>

      {reward === undefined && <Spinner label="Verificando recompensas…" />}

      {reward && (
        <div className="sc-reward-current sc-reward-current--ready">
          <div className="sc-reward-current__icon">
            <Icon.Gift className="sc-icon" />
          </div>
          <div>
            <p className="sc-reward-current__name">{reward.label}</p>
            <p className="sc-reward-current__meta">Lista para canjear</p>
          </div>
        </div>
      )}

      {redeemError && <p className="sc-login__error">{redeemError}</p>}

      <PrimaryButton onClick={onRegisterSale}>Registrar compra</PrimaryButton>
      {reward && (
        <SecondaryButton onClick={handleRedeem} disabled={redeeming}>
          {redeeming ? "Canjeando…" : "Canjear recompensa"}
        </SecondaryButton>
      )}
    </div>
  );
}
