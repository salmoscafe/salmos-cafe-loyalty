export function formatCurrency(amount, currency = "MXN") {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

export function formatDateTime(isoString) {
  const d = new Date(isoString);
  const datePart = d.toLocaleDateString("es-MX", { day: "numeric", month: "long" });
  const timePart = d.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit" });
  return `${datePart} · ${timePart}`;
}

export function formatDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
}

export function isToday(isoString) {
  const d = new Date(isoString);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

export function relativeDay(isoString) {
  return isToday(isoString) ? "Hoy" : formatDate(isoString);
}
