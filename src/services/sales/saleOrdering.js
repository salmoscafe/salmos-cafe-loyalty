// ---------------------------------------------------------------
// saleOrdering — Orden de visitas/compras para Activity (newest→oldest).
//
// La fecha que ordena es la REAL del ticket de Loyverse (`receipt_date`),
// con `created_at` únicamente como fallback mientras la migración 0010
// no está desplegada en la BD. Puro y sin dependencias: unit-testable
// con node --test (ver tests/visit-ordering.test.mjs).
// ---------------------------------------------------------------

// Timestamp con el que se ordena una visita. Preferencia:
//   1) receiptDate — fecha real del ticket (timestamptz de Loyverse);
//   2) visitDate   — fecha de negocio (date-only del sync);
//   3) created_at  — instante de sincronización (fallback);
//   0              — datos no parseables se tratan como los más antiguos.
export function visitSortTimestamp(sale) {
  const ts = sale?.receiptDate || sale?.visitDate || sale?.createdAt;
  if (!ts) return 0;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// Comparador descendente (más reciente primero) para
// `sales = sales.sort(compareVisitsDesc)`.
export function compareVisitsDesc(a, b) {
  return visitSortTimestamp(b) - visitSortTimestamp(a);
}