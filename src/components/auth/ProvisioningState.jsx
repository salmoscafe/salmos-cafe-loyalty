import React from "react";
import { IconMark } from "../common/BrandMark.jsx";
import { PrimaryButton } from "../common/ui.jsx";

export function ProvisioningState({ status, onRetry }) {
  return (
    <div className="sc-provisioning">
      <IconMark on="cream" className="sc-provisioning__mark" />
      {status === "error" ? (
        <>
          <p className="sc-provisioning__title">Algo salió mal.</p>
          <p className="sc-provisioning__sub">Intenta de nuevo.</p>
          <PrimaryButton onClick={onRetry}>Reintentar</PrimaryButton>
        </>
      ) : (
        <>
          <span className="sc-spinner sc-spinner--light" />
          <p className="sc-provisioning__title">Estamos preparando tu tarjeta Salmos</p>
          <p className="sc-provisioning__sub">Esto toma solo un momento.</p>
        </>
      )}
    </div>
  );
}
