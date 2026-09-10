import React, { useState } from "react";
import { Icon } from "../../components/common/icons.jsx";
import { staffService } from "../../services/index.js";
import { PrimaryButton, ErrorState } from "../../components/common/ui.jsx";

// No hay cámara real disponible en este prototipo. El recuadro de
// abajo representa dónde vivirá el lector de QR de verdad; el campo
// "Simular escaneo" es una herramienta de desarrollo, claramente
// separada del flujo real (que solo recibirá el token del QR).
export function ScannerScreen({ onBack, onFound }) {
  const [tokenInput, setTokenInput] = useState("SC-004821");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);

  async function handleScan() {
    setScanning(true);
    setError(null);
    const res = await staffService.scanCustomerToken(tokenInput.trim());
    setScanning(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onFound(res);
  }

  return (
    <div className="sc-screen">
      <button className="sc-back-link" onClick={onBack}>
        <Icon.ArrowLeft className="sc-icon-sm" /> Atrás
      </button>
      <h1 className="sc-screen-title">Escanear tarjeta</h1>

      <div className="sc-scan-area">
        {scanning ? <span className="sc-spinner" /> : <Icon.Scan className="sc-icon-xl" />}
        <p>{scanning ? "Buscando cliente…" : "Apunta la cámara al QR del cliente"}</p>
      </div>

      {error && <ErrorState message={error} />}

      <div className="sc-demo-box">
        <p className="sc-demo-box__label">Simular escaneo (solo para esta demo)</p>
        <input
          className="sc-input"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="Número de tarjeta"
        />
      </div>

      <PrimaryButton onClick={handleScan} disabled={scanning}>
        {scanning ? "Escaneando…" : "Escanear"}
      </PrimaryButton>
    </div>
  );
}
