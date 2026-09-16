import { delay } from "../../lib/delay.js";
import { staffProfiles, auditLogs, branches } from "../../data/mockDatabase.js";
import { findCustomerByToken } from "../customers/customerService.js";
import { callLoyaltyEdge } from "../loyalty/loyaltyEdgeClient.js";
import { isDemoMode } from "../auth/authService.js";

// ---------------------------------------------------------------
// staffService — operaciones específicas del flujo de empleado.
// Reutiliza customerService para la búsqueda; no duplica lógica.
// ---------------------------------------------------------------

// CHECKPOINT 3.1: en modo real la búsqueda por token de QR va a la Edge
// Function `loyalty-engine` (action lookup) con el JWT del empleado; en
// modo demo sigue resolviendo contra el mock (sin red). Misma forma de
// respuesta `{ ok, customer, cycle, progress, reward }`, aunque en demo
// el mock también devuelve `card` (uso interno del flujo demo).
export async function scanCustomerToken(token) {
  if (isDemoMode) {
    await delay(700); // simula el tiempo de "lectura" del QR
    return findCustomerByToken(token);
  }
  return callLoyaltyEdge({ operation: "lookup", token });
}

export async function listBranches() {
  await delay(150);
  return branches.filter((b) => b.status === "active");
}

export async function getStaffById(staffId) {
  await delay(150);
  return staffProfiles.find((s) => s.id === staffId) || null;
}

export async function getRecentActivityForStaff(staffId) {
  await delay(250);
  return auditLogs
    .filter((l) => l.actorId === staffId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 20);
}
