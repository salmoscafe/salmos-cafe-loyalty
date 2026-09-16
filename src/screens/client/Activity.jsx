import React, { useEffect, useState } from "react";
import { Icon } from "../../components/common/icons.jsx";
import { Spinner, ErrorState, EmptyState } from "../../components/common/ui.jsx";
import { ReceiptPrinter } from "../../components/activity/ReceiptPrinter.jsx";
import { salesService, rewardService } from "../../services/index.js";
import { formatCurrency, formatDateTime } from "../../lib/format.js";

export function ActivityScreen({ customer, card }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [selectedSale, setSelectedSale] = useState(null);
  const [printKey, setPrintKey] = useState(0);

  useEffect(() => {
    if (!customer || !card) return;
    let cancelled = false;

    async function load() {
      try {
        const [sales, rewards] = await Promise.all([
          salesService.getSalesForCustomer(customer.profileId || customer.id),
          rewardService.getRewardsForCard(card.id),
        ]);
        if (cancelled) return;

        const purchaseEvents = sales.map((s) => ({
          id: s.id,
          type: s.status === "cancelled" ? "purchase_cancelled" : "purchase",
          date:
            s.receiptDate ||
            (s.status === "cancelled" ? s.cancelledAt : s.createdAt),
          amount: s.amount,
          sale: s,
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
      } catch (e) {
        console.error("[Activity] load", e);
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
    reward_earned: () => "🎉 ¡Conseguiste una recompensa!",
    reward_redeemed: () => "☕ Recompensa canjeada",
    reward_cancelled: () => "Recompensa cancelada",
    reward_expired: () => "Recompensa vencida",
  };

  function openReceipt(ev) {
    setPrintKey((k) => k + 1);
    setSelectedSale(ev.sale);
  }

  function backToActivity() {
    setSelectedSale(null);
  }

  if (selectedSale) {
    return (
      <div className="sc-screen">
        <button type="button" className="sc-back-link" onClick={backToActivity}>
          <Icon.ArrowLeft className="sc-icon-sm" />
          Actividad
        </button>
        <ReceiptPrinter key={printKey} sale={selectedSale} onClose={backToActivity} />
      </div>
    );
  }

  return (
    <div className="sc-screen">
      <h1 className="sc-screen-title">Actividad</h1>

      {error && <ErrorState message={error} />}
      {!error && events === null && <Spinner label="Cargando…" />}
      {!error && events && events.length === 0 && (
        <EmptyState title="Todavía no hay actividad." hint="Tu primera visita aparecerá aquí." />
      )}
      {!error && events && events.length > 0 && (
        <>
          <h2 className="sc-section-label sc-timeline-label">Tus visitas</h2>
          <ul className="sc-timeline">
          {events.map((ev, idx) => {
            const isPurchase = ev.type === "purchase" || ev.type === "purchase_cancelled";
            const inner = (
              <>
                <span className="sc-timeline__dot">
                  {ev.type === "purchase" && <Icon.Receipt className="sc-icon-sm" />}
                  {ev.type === "purchase_cancelled" && <Icon.Close className="sc-icon-sm" />}
                  {ev.type === "reward_earned" && <Icon.Gift className="sc-icon-sm" />}
                  {ev.type === "reward_redeemed" && <Icon.Check className="sc-icon-sm" />}
                  {(ev.type === "reward_cancelled" || ev.type === "reward_expired") && <Icon.Close className="sc-icon-sm" />}
                </span>
                <span className="sc-timeline__body">
                  <span className="sc-timeline__title">{LABELS[ev.type](ev)}</span>
                  {!isPurchase && <span className="sc-timeline__meta">{ev.label}</span>}
                  <span className="sc-timeline__meta">{formatDateTime(ev.date)}</span>
                </span>
                {isPurchase && <Icon.ChevronRight className="sc-icon-sm sc-timeline__chevron" />}
              </>
            );

            return (
              <li key={ev.id} className="sc-timeline__item">
                {idx !== events.length - 1 && <span className="sc-timeline__line" />}
                {isPurchase ? (
                  <button
                    type="button"
                    className={`sc-timeline__hit sc-timeline__hit--${ev.type}`}
                    onClick={() => openReceipt(ev)}
                    aria-label={`Ver detalle de ${LABELS[ev.type](ev)}`}
                  >
                    {inner}
                  </button>
                ) : (
                  <span className="sc-timeline__hit" aria-hidden="true">
                    {inner}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        </>
      )}
    </div>
  );
}