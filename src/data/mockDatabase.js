// ---------------------------------------------------------------
// "Base de datos" en memoria. Esto es lo único en todo el proyecto
// que sabe que los datos son falsos. Ningún screen la importa
// directamente — solo los services/*.
//
// Cuando exista Supabase, este archivo se reemplaza por llamadas
// reales y el resto de la app no se entera.
// ---------------------------------------------------------------

const REQUIRED_VISITS = 7;
const MIN_SALE_AMOUNT = 50;
const REWARD_MAX_VALUE = 150;
const REWARD_EXPIRY_MONTHS = 3;

let nextId = 1000;
function generateId(prefix) {
  nextId += 1;
  return `${prefix}_${nextId}`;
}

// --- branches --------------------------------------------------------------
export const branches = [
  { id: "branch_1", name: "Salmos Café · Centro", status: "active" },
  { id: "branch_2", name: "Salmos Café · Playas", status: "active" },
];

// --- customers -----------------------------------------------------------
export const customers = [
  {
    id: "cus_1",
    name: "Javier Castro",
    email: "javier@example.com",
    emailVerified: true,
    phone: "+52 664 123 4567",
    createdAt: "2026-03-12T10:00:00-08:00",
  },
  {
    id: "cus_2",
    name: "María López",
    email: "maria.lopez@example.com",
    emailVerified: true,
    phone: "+52 664 987 6543",
    createdAt: "2026-05-02T09:30:00-08:00",
  },
];

// --- auth_identities -------------------------------------------------------
// 1 customer puede tener N identidades (google / email / phone).
// Nunca se crea un customer nuevo si ya existe una identidad con
// el mismo email verificado o el mismo teléfono.
export const authIdentities = [
  { id: "id_1", customerId: "cus_1", provider: "email", providerId: "javier@example.com" },
  { id: "id_2", customerId: "cus_1", provider: "phone", providerId: "+52 664 123 4567" },
  { id: "id_3", customerId: "cus_1", provider: "google", providerId: "javier.castro@gmail.com" },
  { id: "id_4", customerId: "cus_2", provider: "email", providerId: "maria.lopez@example.com" },
  { id: "id_5", customerId: "cus_2", provider: "phone", providerId: "+52 664 987 6543" },
];

// --- cards -----------------------------------------------------------------
// branchId NO va aquí: las dos sucursales comparten la misma tarjeta/ciclo.
export const cards = [
  { id: "card_1", customerId: "cus_1", cardNumber: "SC-004821", status: "active" },
];

// --- loyalty_cycles ----------------------------------------------------------
// Nunca se borra un ciclo. Uno "completed" queda como historial.
export const loyaltyCycles = [
  {
    id: "cyc_0",
    cardId: "card_1",
    visits: 8,
    requiredVisits: 8,
    status: "completed",
    startedAt: "2026-06-20T09:00:00-08:00",
    completedAt: "2026-08-15T12:00:00-08:00",
    rewardId: "rwd_0",
  },
  {
    id: "cyc_1",
    cardId: "card_1",
    visits: 5,
    requiredVisits: REQUIRED_VISITS,
    status: "active",
    startedAt: "2026-08-15T12:05:00-08:00",
    completedAt: null,
    rewardId: null,
  },
];

// --- sales -------------------------------------------------------------------
// status: "completed" | "cancelled". cycleId/triggeredRewardId quedan fijados
// por salesService.registerSale para que cancelSale sepa exactamente qué
// revertir sin tener que adivinar.
export const sales = [
  { id: "sale_1", customerId: "cus_1", cardId: "card_1", branchId: "branch_1", employeeId: "emp_1", amount: 95, paymentMethod: "Tarjeta", status: "completed", cancelledAt: null, externalSaleId: "seed_sale_1", cycleId: "cyc_1", triggeredRewardId: null, createdAt: "2026-08-18T09:10:00-08:00", items: [ { name: "Espresso", quantity: 1, unit_price: 40, total: 40 }, { name: "Croissant", quantity: 1, unit_price: 55, total: 55 } ] },
  { id: "sale_2", customerId: "cus_1", cardId: "card_1", branchId: "branch_1", employeeId: "emp_1", amount: 120, paymentMethod: "Efectivo", status: "completed", cancelledAt: null, externalSaleId: "seed_sale_2", cycleId: "cyc_1", triggeredRewardId: null, createdAt: "2026-08-21T16:40:00-08:00", items: [ { name: "Concha", quantity: 1, unit_price: 40, total: 40 }, { name: "Espresso", quantity: 2, unit_price: 40, total: 80 } ] },
  { id: "sale_3", customerId: "cus_1", cardId: "card_1", branchId: "branch_2", employeeId: "emp_2", amount: 85, paymentMethod: "Tarjeta", status: "completed", cancelledAt: null, externalSaleId: "seed_sale_3", cycleId: "cyc_1", triggeredRewardId: null, createdAt: "2026-08-25T08:55:00-08:00", items: [ { name: "Espresso", quantity: 1, unit_price: 40, total: 40 }, { name: "Muffin de arándano", quantity: 1, unit_price: 45, total: 45 } ] },
  { id: "sale_4", customerId: "cus_1", cardId: "card_1", branchId: "branch_1", employeeId: "emp_1", amount: 150, paymentMethod: "Tarjeta", status: "completed", cancelledAt: null, externalSaleId: "seed_sale_4", cycleId: "cyc_1", triggeredRewardId: null, createdAt: "2026-08-28T11:20:00-08:00", items: [ { name: "Cold brew", quantity: 1, unit_price: 60, total: 60 }, { name: "Croissant", quantity: 1, unit_price: 55, total: 55 }, { name: "Pan de elote", quantity: 1, unit_price: 35, total: 35 } ] },
  { id: "sale_5", customerId: "cus_1", cardId: "card_1", branchId: "branch_2", employeeId: "emp_2", amount: 90, paymentMethod: "Efectivo", status: "completed", cancelledAt: null, externalSaleId: "seed_sale_5", cycleId: "cyc_1", triggeredRewardId: null, createdAt: "2026-08-31T13:05:00-08:00", items: [ { name: "Concha", quantity: 1, unit_price: 40, total: 40 }, { name: "Éclair de chocolate", quantity: 1, unit_price: 50, total: 50 } ] },
];

// --- rewards -----------------------------------------------------------------
// status almacenado: "available" | "redeemed" | "cancelled".
// "expired" se DERIVA en rewardService (available + now > expiresAt),
// nunca se escribe aquí — así el historial nunca miente sobre lo que pasó.
export const rewards = [
  {
    id: "rwd_0",
    cycleId: "cyc_0",
    label: "Café gratis",
    maxValue: REWARD_MAX_VALUE,
    status: "redeemed",
    earnedAt: "2026-08-14T18:00:00-08:00",
    expiresAt: "2026-11-14T18:00:00-08:00",
    redeemedAt: "2026-08-15T12:04:00-08:00",
    redeemedBy: "emp_1",
  },
];

// --- tickets -----------------------------------------------------------------
// Fuera del camino crítico en V1 (los socios decidieron que no es
// prioridad). Se deja el archivo/tabla como punto de extensión futuro;
// salesService.registerSale ya NO lo invoca.
export const tickets = [];

// --- staff_profiles ------------------------------------------------------------
export const staffProfiles = [
  { id: "emp_1", name: "Ana Beltrán", email: "ana@example.com", role: "staff", active: true, pin: "1234" },
  { id: "emp_2", name: "Marco Reyes", email: "marco@example.com", role: "staff", active: true, pin: "5678" },
  { id: "emp_3", name: "Luisa Padilla", email: "luisa@example.com", role: "staff", active: true, pin: "2468" },
  { id: "emp_9", name: "Diana Salazar", email: "diana@example.com", role: "admin", active: true, pin: "9999" },
];

// --- audit_logs ------------------------------------------------------------------
export const auditLogs = [];

export function logAudit({ actorId, actorRole, customerId = null, saleId = null, action }) {
  auditLogs.push({
    id: generateId("log"),
    actorId,
    actorRole,
    customerId,
    saleId,
    action,
    timestamp: new Date().toISOString(),
  });
}

export {
  generateId,
  REQUIRED_VISITS,
  MIN_SALE_AMOUNT,
  REWARD_MAX_VALUE,
  REWARD_EXPIRY_MONTHS,
};
