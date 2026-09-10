// ---------------------------------------------------------------
// customer_code — identificador ESTABLE del cliente (ej. SC-8K2MQX4Z).
// Es lo que va en el QR (a través de cardNumber, hoy) y el valor que
// se envía a Loyverse como `customer_code`. NO contiene email ni
// teléfono a propósito. Alfabeto sin ambigüedad óptica (sin O/0/I/L/1).
// ---------------------------------------------------------------

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateCustomerCode() {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let code = "";
  for (let i = 0; i < bytes.length; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `SC-${code}`;
}