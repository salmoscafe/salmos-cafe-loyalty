// ---------------------------------------------------------------
// smtpConn — resolución de la conexión SMTP del correo del ticket.
//
// El transporte es nodemailer (npm:nodemailer@^9); esta función decide el
// puerto. El proyecto usa Gmail con implicit TLS en 465 (secure=true).
// Default: 465. Un SMTP_PORT explícito válido se respeta; en ese caso
// nodemailer elige el canal según el puerto (465 → implicit TLS,
// 587 → STARTTLS automático, 25 → plano).
// ---------------------------------------------------------------

export function resolveSmtpPort(envValue) {
  const n = Number(envValue);
  if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  return 465;
}