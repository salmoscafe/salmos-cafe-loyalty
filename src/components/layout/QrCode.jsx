import React from "react";
import { QRCodeCanvas } from "qrcode.react";

// ---------------------------------------------------------------
// QR real y escaneable del número de tarjeta (customer_code).
// El token llega resuelto desde afuera tal cual (hoy: el
// customer_code del cliente; mañana: un token firmado por el
// backend si se decide).
//
// Se renderiza en un <canvas> a 2x de su tamaño visual para que
// se vea nítido en pantallas de alta densidad y sea legible por
// la cámara de un celular.
//
// Se mantiene el marco `.sc-qr` (tile blanco con sombra propio de
// Salmos). Se quitan las esquinas decorativas del placeholder, que
// taparían módulos del QR real y dificultarían el escaneo.
// ---------------------------------------------------------------

export function QrCode({ token, size = 184 }) {
  const value = String(token ?? "");
  if (!value) return null;

  return (
    <div className="sc-qr">
      <QRCodeCanvas
        value={value}
        size={size * 2}
        level="M"
        marginSize={4}
        bgColor="#ffffff"
        fgColor="#000000"
        style={{ width: size, height: size }}
      />
    </div>
  );
}