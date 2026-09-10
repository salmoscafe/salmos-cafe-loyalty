import React from "react";

// Pantallas reales en la navegación de Admin, con layout, pero sin
// implementación todavía (Fase 2): Detalle de cliente, Ventas,
// Recompensas, Staff y Configuración. Así el admin ya puede navegar
// el producto completo aunque esas secciones no tengan datos reales.
export function ComingSoon({ title }) {
  return (
    <div className="sc-admin-screen">
      <h1 className="sc-admin-title">{title}</h1>
      <div className="sc-admin-empty">
        <p>Esta sección se implementa en la Fase 2.</p>
      </div>
    </div>
  );
}
