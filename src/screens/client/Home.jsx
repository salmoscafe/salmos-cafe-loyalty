import React from "react";
import { Wordmark, IconMark } from "../../components/common/BrandMark.jsx";
import { StampTrack } from "../../components/loyalty/StampTrack.jsx";
import { Icon } from "../../components/common/icons.jsx";
import { Spinner, ErrorState, PrimaryButton } from "../../components/common/ui.jsx";
import { SyncBanner } from "../../components/loyalty/SyncBanner.jsx";
import { REQUIRED_VISITS } from "../../services/index.js";

export function HomeScreen({ customer, card, cycle, currentReward, loading, error, onRetry, onRetrySync, onOpenQr }) {
  if (loading) return <div className="sc-screen"><Spinner label="Cargando tu tarjeta…" /></div>;
  if (error) return <div className="sc-screen"><ErrorState message={error} onRetry={onRetry} /></div>;

  const visits = cycle?.visits ?? 0;
  const required = cycle?.requiredVisits ?? REQUIRED_VISITS;
  const remaining = Math.max(required - visits, 0);
  const unlocked = Boolean(currentReward);
  const half = visits === Math.floor(required / 2);

  return (
    <div className="sc-screen">
      <div className="sc-hero-copy">
        <p className="sc-eyebrow-plain">Tu tarjeta</p>
        <h1 className="sc-hero-title">
          {unlocked ? "Tu café gratis te espera" : `Estás a ${remaining} visita${remaining === 1 ? "" : "s"} de tu recompensa`}
        </h1>
      </div>

      <SyncBanner status={customer.loyverseSyncStatus} onRetry={onRetrySync} />

      <div className={"sc-card" + (unlocked ? " sc-card--unlocked" : "")}>
        <div className="sc-card__texture" aria-hidden="true" />
        <div className="sc-card__row-top">
          <span className="sc-card__type">Miembro</span>
        </div>

        <Wordmark on="navy" className="sc-card__wordmark" />

        <div className="sc-card__identity">
          <span className="sc-card__name">{customer.name}</span>
          <span className="sc-card__number">{card.cardNumber}</span>
        </div>

        <StampTrack visits={visits} required={required} />

        <div className="sc-card__perforation" aria-hidden="true">
          {Array.from({ length: 26 }).map((_, i) => (
            <span key={i} />
          ))}
        </div>

        <div className="sc-card__stub">
          <div className="sc-card__stub-text">
            <span className="sc-card__progress-num">{visits}/{required}</span>
            <span className="sc-card__progress-label">
              {unlocked ? "¡Recompensa lista!" : half ? "Vas a la mitad" : "visitas"}
            </span>
          </div>
          <button className="sc-card__qr-link" onClick={() => onOpenQr("show")}>
            Mostrar mi QR
          </button>
        </div>
      </div>

      <p className="sc-tagline">Donde el café es un verso al paladar</p>

      <div className="sc-next-reward">
        <div className="sc-next-reward__icon">
          <Icon.Cup className="sc-icon" />
        </div>
        <div className="sc-next-reward__body">
          <p className="sc-next-reward__label">Tu próxima recompensa</p>
          <p className="sc-next-reward__name">Café gratis</p>
          <p className="sc-next-reward__sub">
            {unlocked ? "Ya puedes canjearla" : `Te faltan ${remaining} visita${remaining === 1 ? "" : "s"}`}
          </p>
          <div className="sc-progressbar">
            <div className="sc-progressbar__fill" style={{ width: `${(visits / required) * 100}%` }} />
          </div>
        </div>
      </div>

      {unlocked ? (
        <PrimaryButton onClick={() => onOpenQr("redeem")}>Mostrar QR para canjear</PrimaryButton>
      ) : (
        <p className="sc-hint">Cada compra que registra el equipo suma una visita automáticamente.</p>
      )}
    </div>
  );
}
