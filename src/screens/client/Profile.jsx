import React, { useEffect, useState } from "react";
import { Icon } from "../../components/common/icons.jsx";
import { Spinner, ErrorState } from "../../components/common/ui.jsx";
import { SyncBanner } from "../../components/loyalty/SyncBanner.jsx";
import { getCycleHistory, rewardService } from "../../services/index.js";
import { formatDate } from "../../lib/format.js";

export function ProfileScreen({ customer, card, onRetrySync, onOpenSettings, onSignOut }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!card) return;
    let cancelled = false;
    Promise.all([getCycleHistory(card.id), rewardService.getRewardsForCard(card.id)])
      .then(([cycles, rewards]) => {
        if (cancelled) return;
        const totalVisits = cycles.reduce((sum, c) => sum + c.visits, 0);
        setStats({
          totalVisits,
          rewardsEarned: rewards.length,
          rewardsRedeemed: rewards.filter((r) => r.status === "redeemed").length,
        });
      })
      .catch(() => !cancelled && setError("No pudimos cargar tus estadísticas."));
    return () => {
      cancelled = true;
    };
  }, [card]);

  return (
    <div className="sc-screen">
      <h1 className="sc-screen-title">Perfil</h1>

      <SyncBanner status={customer.loyverseSyncStatus} onRetry={onRetrySync} />

      <div className="sc-profile-head">
        <div className="sc-avatar">{customer.name.charAt(0)}</div>
        <div>
          <p className="sc-profile-name">{customer.name}</p>
          <p className="sc-profile-email">{customer.email}</p>
        </div>
      </div>

      <div className="sc-info-card">
        <div className="sc-info-row">
          <span>Tarjeta</span>
          <span>{card.cardNumber} · Miembro</span>
        </div>
        <div className="sc-info-row">
          <span>Teléfono</span>
          <span>{customer.phone}</span>
        </div>
        <div className="sc-info-row">
          <span>Cliente desde</span>
          <span>{formatDate(customer.createdAt)}</span>
        </div>
      </div>

      {error && <ErrorState message={error} />}
      {!error && !stats && <Spinner label="Cargando estadísticas…" />}
      {!error && stats && (
        <div className="sc-stats">
          <div className="sc-stat">
            <span className="sc-stat__num">{stats.totalVisits}</span>
            <span className="sc-stat__label">visitas</span>
          </div>
          <div className="sc-stat">
            <span className="sc-stat__num">{stats.rewardsEarned}</span>
            <span className="sc-stat__label">obtenidas</span>
          </div>
          <div className="sc-stat">
            <span className="sc-stat__num">{stats.rewardsRedeemed}</span>
            <span className="sc-stat__label">utilizadas</span>
          </div>
        </div>
      )}

      <div className="sc-wallet-row">
        <button className="sc-wallet-btn" disabled>
          <Icon.Wallet className="sc-icon-sm" /> Agregar a Apple Wallet
        </button>
        <button className="sc-wallet-btn" disabled>
          <Icon.Wallet className="sc-icon-sm" /> Agregar a Google Wallet
        </button>
      </div>

      <button className="sc-profile-link" onClick={onOpenSettings}>
        <span>Configuración</span>
        <Icon.ChevronRight className="sc-icon-sm" />
      </button>

      <button className="sc-signout" onClick={onSignOut}>
        Cerrar sesión
      </button>
    </div>
  );
}
