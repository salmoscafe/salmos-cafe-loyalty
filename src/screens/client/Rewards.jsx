import React, { useEffect, useState } from "react";
import { Icon } from "../../components/common/icons.jsx";
import { Spinner, ErrorState, EmptyState } from "../../components/common/ui.jsx";
import { rewardService, REQUIRED_VISITS } from "../../services/index.js";
import { formatDate } from "../../lib/format.js";

const PAST_META = {
  redeemed: (r) => `Canjeada el ${formatDate(r.redeemedAt)}`,
  expired: (r) => `Venció el ${formatDate(r.expiresAt)}`,
  cancelled: () => "Cancelada — la venta que la generó fue revertida",
};

export function RewardsScreen({ card, cycle, currentReward }) {
  const [pastRewards, setPastRewards] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!card) return;
    let cancelled = false;
    rewardService
      .getPastRewards(card.id)
      .then((list) => !cancelled && setPastRewards(list))
      .catch(() => !cancelled && setError("No pudimos cargar tus recompensas anteriores."));
    return () => {
      cancelled = true;
    };
  }, [card]);

  const visits = cycle?.visits ?? 0;
  const required = cycle?.requiredVisits ?? REQUIRED_VISITS;
  const remaining = Math.max(required - visits, 0);
  const unlocked = Boolean(currentReward);

  return (
    <div className="sc-screen">
      <h1 className="sc-screen-title">Recompensas</h1>

      <div className="sc-section-label">Recompensa actual</div>
      <div className={"sc-reward-current" + (unlocked ? " sc-reward-current--ready" : "")}>
        <div className="sc-reward-current__icon">
          <Icon.Gift className="sc-icon" />
        </div>
        <div>
          <p className="sc-reward-current__name">Café gratis</p>
          <p className="sc-reward-current__meta">
            {unlocked
              ? `Lista para canjear · vence el ${formatDate(currentReward.expiresAt)}`
              : `${remaining} visita${remaining === 1 ? "" : "s"} restante${remaining === 1 ? "" : "s"}`}
          </p>
        </div>
        {unlocked && <span className="sc-badge">Lista</span>}
      </div>

      <div className="sc-section-label">Recompensas anteriores</div>
      {error && <ErrorState message={error} />}
      {!error && pastRewards === null && <Spinner label="Cargando…" />}
      {!error && pastRewards && pastRewards.length === 0 && (
        <EmptyState title="Aún no tienes recompensas anteriores." hint="Aparecerán aquí cuando se canjeen, venzan o se cancelen." />
      )}
      {!error && pastRewards && pastRewards.length > 0 && (
        <ul className="sc-list">
          {pastRewards.map((r) => (
            <li key={r.id} className="sc-list__item">
              <span className="sc-list__check">
                <Icon.Check className="sc-icon-sm" />
              </span>
              <span className="sc-list__body">
                <span className="sc-list__title">{r.label}</span>
                <span className="sc-list__meta">{PAST_META[r.derivedStatus]?.(r) || ""}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
