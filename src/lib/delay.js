// Simula la latencia de una llamada real de red.
// El día que services/* apunte a Supabase, esta función deja de usarse:
// el propio fetch/RPC ya tiene su latencia real.
export function delay(ms = 350) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
