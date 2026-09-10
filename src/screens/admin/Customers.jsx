import React, { useEffect, useState } from "react";
import { adminService } from "../../services/index.js";
import { Icon } from "../../components/common/icons.jsx";
import { Spinner } from "../../components/common/ui.jsx";

export function AdminCustomers() {
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState(null);

  useEffect(() => {
    let cancelled = false;
    adminService.listCustomersWithCards(query).then((list) => !cancelled && setCustomers(list));
    return () => {
      cancelled = true;
    };
  }, [query]);

  return (
    <div className="sc-admin-screen">
      <h1 className="sc-admin-title">Clientes</h1>

      <div className="sc-admin-search">
        <Icon.Search className="sc-icon-sm" />
        <input
          className="sc-input"
          placeholder="Buscar por nombre, email, teléfono o tarjeta"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {customers === null && <Spinner label="Buscando…" />}
      {customers && (
        <table className="sc-admin-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Email</th>
              <th>Tarjeta</th>
              <th>Progreso</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.email}</td>
                <td>{c.cardNumber}</td>
                <td>{c.visits}/{c.requiredVisits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
