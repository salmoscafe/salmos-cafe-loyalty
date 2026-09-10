import { delay } from "../../lib/delay.js";
import { staffProfiles, auditLogs, branches } from "../../data/mockDatabase.js";
import { findCustomerByToken } from "../customers/customerService.js";

// ---------------------------------------------------------------
// staffService — operaciones específicas del flujo de empleado.
// Reutiliza customerService para la búsqueda; no duplica lógica.
// ---------------------------------------------------------------

export async function scanCustomerToken(token) {
  await delay(700); // simula el tiempo de "lectura" del QR
  return findCustomerByToken(token);
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
