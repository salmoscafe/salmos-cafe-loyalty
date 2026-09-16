import { delay } from "../../lib/delay.js";
import {
  customers,
  sales,
  rewards,
  loyaltyCycles,
  cards,
  branches,
  staffProfiles,
  generateId,
} from "../../data/mockDatabase.js";
import { searchCustomers } from "../customers/customerService.js";
import { REQUIRED_VISITS } from "../../data/mockDatabase.js";
import { isSupabaseConfigured } from "../../lib/supabase/client.js";
import { callAdminEdge } from "./adminEdgeClient.js";

// ---------------------------------------------------------------
// adminService — lecturas agregadas y administración para Admin.
// Dashboard y Clientes usan el mock en memoria (igual que antes);
// la administración de empleados (CHECKPOINT 2) enruta a la Edge
// Function segura `admin-employees` cuando Supabase está configurado
// y a `staffProfiles` en modo demo.
// ---------------------------------------------------------------

function apiError(code, message) {
  const err = new Error(message || "La operación no se pudo completar.");
  err.code = code || "admin_error";
  err.retriable = false;
  return err;
}

export async function getDashboardStats() {
  await delay(350);
  const completedSales = sales.filter((s) => s.status === "completed");
  const totalSales = completedSales.reduce((sum, s) => sum + s.amount, 0);
  const averageTicket = completedSales.length ? totalSales / completedSales.length : 0;

  const byBranch = branches.map((b) => {
    const branchSales = completedSales.filter((s) => s.branchId === b.id);
    return {
      branchId: b.id,
      name: b.name,
      salesCount: branchSales.length,
      salesTotal: branchSales.reduce((sum, s) => sum + s.amount, 0),
    };
  });

  return {
    customers: customers.length,
    activeCycles: loyaltyCycles.filter((c) => c.status === "active").length,
    salesCount: completedSales.length,
    cancelledCount: sales.filter((s) => s.status === "cancelled").length,
    salesTotal: totalSales,
    averageTicket,
    rewardsEarned: rewards.length,
    rewardsRedeemed: rewards.filter((r) => r.status === "redeemed").length,
    byBranch,
  };
}

export async function listCustomersWithCards(query = "") {
  await delay(300);
  const list = await searchCustomers(query);
  return list.map((c) => {
    const card = cards.find((k) => k.customerId === c.id);
    const cycle = card && loyaltyCycles.find((cy) => cy.cardId === card.id && cy.status === "active");
    return {
      ...c,
      cardNumber: card?.cardNumber || "—",
      visits: cycle?.visits ?? 0,
      requiredVisits: cycle?.requiredVisits ?? REQUIRED_VISITS,
    };
  });
}

// ---------------------------------------------------------------
// Empleados (CHECKPOINT 2) — real → Edge Function segura; demo → mock.
// ---------------------------------------------------------------

export async function listEmployees() {
  if (isSupabaseConfigured) {
    const res = await callAdminEdge({ action: "list" });
    if (!res.ok) throw apiError(res.code, res.message);
    return res.employees || [];
  }
  await delay(250);
  return staffProfiles
    .filter((s) => s.role === "staff")
    .map((s) => ({ id: s.id, name: s.name, email: s.email || "", role: s.role, active: s.active }));
}

export async function createEmployee({ email, password, name }) {
  if (isSupabaseConfigured) {
    const res = await callAdminEdge({ action: "create", email, password, name });
    if (!res.ok) throw apiError(res.code, res.message);
    return res.employee;
  }
  await delay(350);
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (staffProfiles.some((s) => (s.email || "").toLowerCase() === cleanEmail)) {
    throw apiError("email_already_exists", "Ese correo ya está registrado. No se creó una segunda cuenta.");
  }
  const employee = {
    id: generateId("emp"),
    name: String(name || "").trim(),
    email: cleanEmail,
    role: "staff",
    active: true,
    // PIN de demostración para que el empleado nuevo pueda entrar en modo demo.
    pin: String(Math.floor(1000 + Math.random() * 9000)),
  };
  staffProfiles.push(employee);
  return { id: employee.id, name: employee.name, email: employee.email, role: employee.role, active: employee.active };
}

export async function updateEmployee({ employeeId, name, active }) {
  if (isSupabaseConfigured) {
    const res = await callAdminEdge({
      action: "update",
      employeeId,
      ...(name !== undefined ? { name } : {}),
      ...(active !== undefined ? { active } : {}),
    });
    if (!res.ok) throw apiError(res.code, res.message);
    return res.employee;
  }
  await delay(300);
  const emp = staffProfiles.find((s) => s.id === employeeId);
  if (!emp) throw apiError("employee_not_found", "No se encontró ese empleado.");
  if (name !== undefined) emp.name = String(name).trim();
  if (active !== undefined) emp.active = active;
  return { id: emp.id, name: emp.name, email: emp.email || "", role: emp.role, active: emp.active };
}

export async function setEmployeeActive({ employeeId, active }) {
  return updateEmployee({ employeeId, active: Boolean(active) });
}
