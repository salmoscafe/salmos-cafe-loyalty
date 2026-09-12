// ---------------------------------------------------------------
// singleFlight — colapsa llamadas concurrentes a UNA sola ejecución.
//
// La sincronización Salmos⇄Loyverse es "buscar → crear": NO es atómica
// contra api.loyverse.com. Si dos sync corren en paralelo (buildSession
// del arranque + Retry del SyncBanner, o dos llamadas solapadas) ambas
// pueden pasar por "no existe → crear" y generar DOS clientes Loyverse
// idénticos (el bug reportado).
//
// `coalesce` asegura que dentro de una sesión de app solo haya una sync
// activa: la segunda llamada recibe la MISMA promesa de la primera.
// Después de que termina (éxito o fallo), la siguiente sincronización
// corre de nuevo (los reintentos siguen funcionando).
// ---------------------------------------------------------------

let active = null;

export function coalesce(fn) {
  if (active) return active;
  const promise = Promise.resolve().then(fn);
  active = promise;
  // Liberar el slot al terminar, sin crear una promesa derivada huérfana
  // (un .finally() sobre una promesa rechazada dispararía
  // unhandledRejection). La promesa original se devuelve al llamador.
  promise.then(
    () => {
      if (active === promise) active = null;
    },
    () => {
      if (active === promise) active = null;
    }
  );
  return promise;
}

// Solo para tests (aisla el estado entre suites).
export function resetSingleFlight() {
  active = null;
}

export function isSingleFlightActive() {
  return active !== null;
}