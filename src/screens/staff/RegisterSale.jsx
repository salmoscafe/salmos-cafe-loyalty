import React, { useEffect, useState } from "react";
import { Icon } from "../../components/common/icons.jsx";
import { staffService } from "../../services/index.js";
import { PrimaryButton, Field, ErrorState, Spinner } from "../../components/common/ui.jsx";

const PAYMENT_METHODS = ["Tarjeta", "Efectivo", "Transferencia"];

export function RegisterSaleScreen({ customer, card, onBack, onSubmit }) {
  const [branches, setBranches] = useState(null);
  const [branchId, setBranchId] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState(PAYMENT_METHODS[0]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    staffService.listBranches().then((list) => {
      if (cancelled) return;
      setBranches(list);
      setBranchId(list[0]?.id || "");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await onSubmit({ amount: Number(amount), paymentMethod, branchId });
    setSubmitting(false);
    if (res && !res.ok) setError(res.error);
  }

  return (
    <div className="sc-screen">
      <button className="sc-back-link" onClick={onBack}>
        <Icon.ArrowLeft className="sc-icon-sm" /> Atrás
      </button>
      <h1 className="sc-screen-title">Registrar compra</h1>

      <div className="sc-info-card">
        <div className="sc-info-row">
          <span>Cliente</span>
          <span>{customer.name}</span>
        </div>
        <div className="sc-info-row">
          <span>Tarjeta</span>
          <span>{card.cardNumber}</span>
        </div>
      </div>

      {branches === null && <Spinner label="Cargando sucursales…" />}

      {branches && (
        <form onSubmit={handleSubmit} className="sc-login__form">
          <Field label="Sucursal">
            <select className="sc-input" value={branchId} onChange={(e) => setBranchId(e.target.value)} required>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Monto de compra (MXN) — mínimo $50">
            <input
              type="number"
              min="1"
              step="0.01"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="sc-input"
              autoFocus
            />
          </Field>
          <Field label="Método de pago (opcional)">
            <select className="sc-input" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
          {error && <ErrorState message={error} />}
          <PrimaryButton type="submit" disabled={submitting}>
            {submitting ? "Registrando…" : "Registrar compra"}
          </PrimaryButton>
        </form>
      )}
    </div>
  );
}
