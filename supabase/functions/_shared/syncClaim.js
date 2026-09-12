// ---------------------------------------------------------------
// syncClaim — claim atómico server-side contra el doble sync de Loyverse.
// Segunda barrera sobre el guard single-flight del frontend: aunque dos
// invocaciones de la Edge Function (pestañas/retries) lleguen a la vez,
// solo una puede "tomar" el claim de la fila; la otra responde busy sin
// llamar a la API de Loyverse.
//
// Agnóstico del transporte (recibe `db` y `transport` mínimos) → unit-test
// con node --test (tests/sync-claim.test.mjs). El adaptador real de la
// Edge Function se construye en index.ts sobre el cliente supabase.
//
//   db: {
//     claim({ authUserId, claim, claimAt, cutoffIso }) -> { count, error }
//       // count === 1 → el UPDATE ... WHERE (claim IS NULL OR claim_at
//       // < cutoff) matching atómicamente; 0 → claim vigente (perdedor).
//     release({ authUserId, claim }) -> { error }
//   }
// ---------------------------------------------------------------

import { createOrLinkLoyverseCustomer } from "./loyverseCore.js";

export const SYNC_CLAIM_LEASE_MS = 10 * 60 * 1000;

export async function acquireSyncClaim(
  db,
  authUserId,
  { leaseMs = SYNC_CLAIM_LEASE_MS, now = Date.now, newId = () => crypto.randomUUID() } = {},
) {
  const claim = newId();
  const ts = now();
  const { count, error } = await db.claim({
    authUserId,
    claim,
    claimAt: new Date(ts).toISOString(),
    cutoffIso: new Date(ts - leaseMs).toISOString(),
  });
  if (error) throw error;
  return { acquired: count === 1, claim };
}

export async function releaseSyncClaim(db, authUserId, claim) {
  const { error } = await db.release({ authUserId, claim });
  if (error) throw error;
  return { released: true };
}

// Orquestación testeable de la sincronización con claim:
//   * already_linked  → perfil ya vinculado: nada que hacer (sin claim).
//   * no_profile      → no existe fila `customers`: no hay dónde claimear.
//   * busy            → otro sync en curso: retriable, sin tocar Loyverse.
//   * done            → listo: `result` es el resultado de
//                       createOrLinkLoyverseCustomer (created/linked/
//                       updated/conflict).
// Errores de createOrLinkLoyverseCustomer se propagan tras liberar el claim.
export async function runLoyverseSync({
  db,
  transport,
  authUserId,
  profile,
  name,
  email,
  phone,
  customerCode,
  leaseMs,
  now,
  newId,
}) {
  if (!profile || !profile.id) {
    return { status: "no_profile" };
  }
  if (profile.loyverse_customer_id && profile.loyverse_sync_status === "synced") {
    return { status: "already_linked", loyverseCustomerId: profile.loyverse_customer_id };
  }

  const acquisition = await acquireSyncClaim(db, authUserId, { leaseMs, now, newId });
  if (!acquisition.acquired) {
    return { status: "busy", retriable: true };
  }

  try {
    const result = await createOrLinkLoyverseCustomer({
      transport,
      name,
      email,
      phone,
      customerCode,
      knownLoyverseCustomerId: profile?.loyverse_customer_id || null,
    });
    return { status: "done", result };
  } finally {
    try {
      await releaseSyncClaim(db, authUserId, acquisition.claim);
    } catch {
      // La liberación falló, pero el lease expirará el claim; nunca
      // enmascarar el resultado principal con un error de la liberación.
    }
  }
}