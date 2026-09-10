import React, { useEffect, useState } from "react";
import { Icon } from "../../components/common/icons.jsx";
import { staffService } from "../../services/index.js";
import { Spinner, EmptyState } from "../../components/common/ui.jsx";
import { formatDateTime } from "../../lib/format.js";

const ACTION_LABELS = {
  PURCHASE_REGISTERED: "Compra registrada",
  VISIT_ADDED: "Visita agregada",
  REWARD_EARNED: "Recompensa generada",
  REWARD_REDEEMED: "Recompensa canjeada",
  TICKET_CREATED: "Ticket creado",
  TICKET_SENT: "Ticket enviado",
  STAFF_SIGNED_IN: "Inicio de sesión",
};

export function StaffActivityScreen({ staff, onBack }) {
  const [logs, setLogs] = useState(null);

  useEffect(() => {
    let cancelled = false;
    staffService.getRecentActivityForStaff(staff.id).then((l) => !cancelled && setLogs(l));
    return () => {
      cancelled = true;
    };
  }, [staff]);

  return (
    <div className="sc-screen">
      <button className="sc-back-link" onClick={onBack}>
        <Icon.ArrowLeft className="sc-icon-sm" /> Atrás
      </button>
      <h1 className="sc-screen-title">Actividad</h1>

      {logs === null && <Spinner label="Cargando…" />}
      {logs && logs.length === 0 && <EmptyState title="Sin actividad todavía" hint="Tus acciones aparecerán aquí." />}
      {logs && logs.length > 0 && (
        <ul className="sc-list">
          {logs.map((l) => (
            <li key={l.id} className="sc-list__item">
              <span className="sc-list__body">
                <span className="sc-list__title">{ACTION_LABELS[l.action] || l.action}</span>
                <span className="sc-list__meta">{formatDateTime(l.timestamp)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
