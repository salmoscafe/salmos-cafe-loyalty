import React, { useEffect, useState } from "react";
import { adminService } from "../../services/index.js";
import { Spinner, ErrorState } from "../../components/common/ui.jsx";
import { formatCurrency } from "../../lib/format.js";

export function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    adminService
      .getDashboardStats()
      .then((s) => !cancelled && setStats(s))
      .catch(() => !cancelled && setError("No pudimos cargar el dashboard."));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <ErrorState message={error} />;
  if (!stats) return <Spinner label="Cargando indicadores…" />;

  const cards = [
    { label: "Clientes", value: stats.customers },
    { label: "Ciclos activos", value: stats.activeCycles },
    { label: "Ventas registradas", value: stats.salesCount },
    { label: "Ventas canceladas", value: stats.cancelledCount },
    { label: "Total vendido", value: formatCurrency(stats.salesTotal) },
    { label: "Ticket promedio", value: formatCurrency(stats.averageTicket) },
    { label: "Recompensas generadas", value: stats.rewardsEarned },
    { label: "Recompensas canjeadas", value: stats.rewardsRedeemed },
  ];

  return (
    <div className="sc-admin-screen">
      <h1 className="sc-admin-title">Dashboard</h1>
      <div className="sc-admin-grid">
        {cards.map((c) => (
          <div key={c.label} className="sc-admin-card">
            <span className="sc-admin-card__value">{c.value}</span>
            <span className="sc-admin-card__label">{c.label}</span>
          </div>
        ))}
      </div>

      <h2 className="sc-admin-subtitle">Por sucursal</h2>
      <table className="sc-admin-table">
        <thead>
          <tr>
            <th>Sucursal</th>
            <th>Ventas</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {stats.byBranch.map((b) => (
            <tr key={b.branchId}>
              <td>{b.name}</td>
              <td>{b.salesCount}</td>
              <td>{formatCurrency(b.salesTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
