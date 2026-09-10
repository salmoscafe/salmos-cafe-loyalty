import React, { useMemo } from "react";

// ---------------------------------------------------------------
// Puramente de presentación: dibuja un patrón tipo-QR a partir de
// un `token` que ya viene resuelto desde afuera (hoy: el número
// de tarjeta del mock; mañana: un token firmado por el backend).
//
// A diferencia del prototipo original, este patrón es determinista
// (hash simple del token) — no es aleatorio en cada render — para
// que quede claro conceptualmente que representa un dato real, no
// un valor decorativo que cambia solo.
//
// Sigue siendo un placeholder visual: no es un QR escaneable de
// verdad. Eso requiere una librería de generación de QR (p. ej.
// `qrcode`) el día que exista el token real — se deja el punto de
// enchufe listo aquí mismo.
// ---------------------------------------------------------------

function hashToken(token) {
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = (h * 31 + token.charCodeAt(i)) >>> 0;
  }
  return h || 1;
}

export function QrCode({ token, size = 11 }) {
  const cells = useMemo(() => {
    let seed = hashToken(token);
    const next = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    return Array.from({ length: size * size }, () => next() > 0.55);
  }, [token, size]);

  return (
    <div className="sc-qr">
      <div className="sc-qr__grid" style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}>
        {cells.map((on, i) => (
          <span key={i} className={on ? "on" : ""} />
        ))}
      </div>
      <div className="sc-qr__corner sc-qr__corner--tl" />
      <div className="sc-qr__corner sc-qr__corner--tr" />
      <div className="sc-qr__corner sc-qr__corner--bl" />
    </div>
  );
}
