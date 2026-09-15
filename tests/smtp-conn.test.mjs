// Configuración SMTP del correo del ticket (send-ticket).
//
// deno.land/x/smtp@v0.7.0 NO implementa STARTTLS (verificado en
// mod.ts → smtp.ts): connect() es TCP plano y connectTLS() es implicit
// TLS. Gmail cifra en 587 solo mediante STARTTLS (no soportado), así
// que el canal correcto con esta librería es implicit TLS en 465.
// Este test valida la resolución del puerto SIN llamar a Gmail.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveSmtpPort } from "../supabase/functions/_shared/smtpConn.js";

test("SMTP: sin configuración se usa implicit TLS 465 (Gmail, nunca 587/STARTTLS)", () => {
  assert.equal(resolveSmtpPort(undefined), 465);
  assert.equal(resolveSmtpPort(null), 465);
  assert.equal(resolveSmtpPort(""), 465);
  assert.equal(resolveSmtpPort("abc"), 465);
});

test("SMTP: puerto explícito válido se respeta (solo si existe en el entorno)", () => {
  assert.equal(resolveSmtpPort("465"), 465);
  assert.equal(resolveSmtpPort("25"), 25);
});

test("SMTP: puertos inválidos caen al default 465 (implicit TLS)", () => {
  assert.equal(resolveSmtpPort("0"), 465);
  assert.equal(resolveSmtpPort("-1"), 465);
  assert.equal(resolveSmtpPort("70000"), 465);
});