import React, { useEffect, useState } from "react";
import { Icon } from "../../components/common/icons.jsx";
import { Spinner, ErrorState, EmptyState } from "../../components/common/ui.jsx";
import { salesService, rewardService } from "../../services/index.js";
import { formatCurrency, formatDateTime } from "../../lib/format.js";

export function ActivityScreen({ customer, card }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!customer || !card) return;
    let cancelled = false;

    async function load() {
      try {
        const [sales, rewards] = await Promise.all([
          salesService.getSalesForCustomer(customer.id),
          rewardService.getRewardsForCard(card.id),
        ]);
        if (cancelled) return;

        const purchaseEvents = sales.map((s) => ({
          id: s.id,
          type: s.status === "cancelled" ? "purchase_cancelled" : "purchase",
          date: s.status === "cancelled" ? s.cancelledAt : s.createdAt,
          amount: s.amount,
        }));

        const rewardEvents = rewards.flatMap((r) => {
          const evs = [{ id: `${r.id}-earned`, type: "reward_earned", date: r.earnedAt, label: r.label }];
          if (r.derivedStatus === "redeemed") {
            evs.push({ id: `${r.id}-redeemed`, type: "reward_redeemed", date: r.redeemedAt, label: r.label });
          } else if (r.derivedStatus === "cancelled") {
            evs.push({ id: `${r.id}-cancelled`, type: "reward_cancelled", date: r.earnedAt, label: r.label });
          } else if (r.derivedStatus === "expired") {
            evs.push({ id: `${r.id}-expired`, type: "reward_expired", date: r.expiresAt, label: r.label });
          }
          return evs;
        });

        const merged = [...purchaseEvents, ...rewardEvents].sort(
          (a, b) => new Date(b.date) - new Date(a.date)
        );
        setEvents(merged);
      } catch {
        if (!cancelled) setError("No pudimos cargar tu actividad.");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [customer, card]);

  const LABELS = {
    purchase: (ev) => `Compra registrada · ${formatCurrency(ev.amount)}`,
    purchase_cancelled: (ev) => `Compra cancelada · ${formatCurrency(ev.amount)}`,
    reward_earned: (ev) => `Recompensa obtenida · ${ev.label}`,
    reward_redeemed: (ev) => `Recompensa canjeada · ${ev.label}`,
    reward_cancelled: (ev) => `Recompensa invalidada · ${ev.label}`,
    reward_expired: (ev) => `Recompensa vencida · ${ev.label}`,
  };

  return (
    <div className="sc-screen">
      <h1 className="sc-screen-title">Actividad</h1>

      {error && <ErrorState message={error} />}
      {!error && events === null && <Spinner label="Cargando…" />}
      {!error && events && events.length === 0 && (
        <EmptyState title="Todavía no hay actividad." hint="Tu primera visita aparecerá aquí." />
      )}
      {!error && events && events.length > 0 && (
        <ul className="sc-timeline">
          {events.map((ev, idx) => (
            <li key={ev.id} className="sc-timeline__item">
              <span className="sc-timeline__dot">
                {ev.type === "purchase" && <Icon.Receipt className="sc-icon-sm" />}
                {ev.type === "purchase_cancelled" && <Icon.Close className="sc-icon-sm" />}
                {ev.type === "reward_earned" && <Icon.Gift className="sc-icon-sm" />}
                {ev.type === "reward_redeemed" && <Icon.Check className="sc-icon-sm" />}
                {(ev.type === "reward_cancelled" || ev.type === "reward_expired") && <Icon.Close className="sc-icon-sm" />}
              </span>
              {idx !== events.length - 1 && <span className="sc-timeline__line" />}
              <span className="sc-timeline__body">
                <span className="sc-timeline__title">{LABELS[ev.type](ev)}</span>
                <span className="sc-timeline__meta">{formatDateTime(ev.date)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
