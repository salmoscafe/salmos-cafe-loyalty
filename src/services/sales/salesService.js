import { delay } from "../../lib/delay.js";
import {
  sales,
  customers,
  branches,
  loyaltyCycles,
  rewards,
  MIN_SALE_AMOUNT,
  generateId,
  logAudit,
} from "../../data/mockDatabase.js";
import { addVisit } from "../loyalty/loyaltyService.js";

// ---------------------------------------------------------------
// salesService — el único punto de entrada para "registrar una
// compra" y para cancelarla. Encapsula TODAS las reglas de venta
// válida (monto, límite diario, idempotencia) — loyaltyService.addVisit
// asume que ya se validó y solo suma.
//
//   Una compra válida registrada por Staff produce una visita.
//   El cliente nunca llama a esto. Solo Staff/Admin.
//
// En Supabase esto será una Edge Function transaccional; aquí, al
// ser JS de un solo hilo, no hay validación parcial: si algo falla
// se retorna el error ANTES de tocar el mock.
// ---------------------------------------------------------------

function isSameCalendarDay(isoA, isoB) {
  return new Date(isoA).toDateString() === new Date(isoB).toDateString();
}

function hasValidVisitToday(customerId, nowIso) {
  return sales.some(
    (s) => s.customerId === customerId && s.status === "completed" && isSameCalendarDay(s.createdAt, nowIso)
  );
}

function buildResultFromExistingSale(sale) {
  const cycle = loyaltyCycles.find((cy) => cy.id === sale.cycleId) || null;
  const newReward = sale.triggeredRewardId ? rewards.find((r) => r.id === sale.triggeredRewardId) || null : null;
  return { ok: true, sale, cycle, newReward, reused: true };
}

export async function registerSale({ customerId, cardId, branchId, amount, paymentMethod, employeeId, externalSaleId }) {
  await delay(600);

  // Idempotencia primero: si ya procesamos este externalSaleId, se
  // devuelve el resultado existente en vez de generar otra visita.
  if (externalSaleId) {
    const existing = sales.find((s) => s.externalSaleId === externalSaleId);
    if (existing) return buildResultFromExistingSale(existing);
  }

  const customer = customers.find((c) => c.id === customerId);
  if (!customer) return { ok: false, error: "Cliente no encontrado." };

  const branch = branches.find((b) => b.id === branchId && b.status === "active");
  if (!branch) return { ok: false, error: "Selecciona una sucursal válida." };

  if (!amount || amount < MIN_SALE_AMOUNT) {
    return { ok: false, error: `El monto mínimo para generar una visita es $${MIN_SALE_AMOUNT} MXN.` };
  }

  const nowIso = new Date().toISOString();
  if (hasValidVisitToday(customerId, nowIso)) {
    return { ok: false, error: "Este cliente ya registró una visita válida hoy." };
  }

  const sale = {
    id: generateId("sale"),
    customerId,
    cardId,
    branchId,
    employeeId,
    amount,
    paymentMethod: paymentMethod || "No especificado",
    status: "completed",
    cancelledAt: null,
    externalSaleId: externalSaleId || generateId("extsale"),
    cycleId: null,
    triggeredRewardId: null,
    createdAt: nowIso,
  };
  sales.push(sale);
  logAudit({ actorId: employeeId, actorRole: "staff", customerId, saleId: sale.id, action: "PURCHASE_REGISTERED" });

  const { cycle, newReward } = addVisit({ cardId, actorId: employeeId, actorRole: "staff" });
  sale.cycleId = cycle.id;
  if (newReward) sale.triggeredRewardId = newReward.id;

  return { ok: true, sale, cycle, newReward };
}

// Revierte una venta y, si corresponde, la recompensa que generó.
// Bloquea la cancelación (sin mutar nada) si esa recompensa ya fue
// redimida, o si el ciclo ya se completó por una venta posterior.
export async function cancelSale(saleId, { actorId, actorRole }) {
  await delay(400);

  const sale = sales.find((s) => s.id === saleId);
  if (!sale) return { ok: false, error: "Venta no encontrada." };
  if (sale.status !== "completed") return { ok: false, error: "Esta venta ya está cancelada." };

  const cycle = loyaltyCycles.find((cy) => cy.id === sale.cycleId);
  if (!cycle) return { ok: false, error: "No se encontró el ciclo asociado a esta venta." };

  let reward = null;
  if (sale.triggeredRewardId) {
    reward = rewards.find((r) => r.id === sale.triggeredRewardId) || null;
    if (reward && reward.status === "redeemed") {
      return { ok: false, error: "Esta venta generó una recompensa que ya fue redimida. No se puede cancelar." };
    }
  } else if (cycle.status === "completed") {
    // Una venta anterior, no-disparadora, dentro de un ciclo que una venta
    // POSTERIOR ya cerró. Revertirla dejaría un ciclo "completed" con menos
    // visitas de las que dice tener — se bloquea en vez de arriesgar un
    // estado incoherente.
    return {
      ok: false,
      error: "No se puede cancelar: el ciclo ya se completó con una recompensa asociada a otra venta.",
    };
  }

  // Validaciones superadas — se aplica la reversión completa.
  sale.status = "cancelled";
  sale.cancelledAt = new Date().toISOString();
  logAudit({ actorId, actorRole, customerId: sale.customerId, saleId: sale.id, action: "SALE_CANCELLED" });

  cycle.visits = Math.max(cycle.visits - 1, 0);
  logAudit({ actorId, actorRole, customerId: sale.customerId, saleId: sale.id, action: "VISIT_REVERTED" });

  if (reward) {
    reward.status = "cancelled";
    cycle.status = "active";
    cycle.completedAt = null;
    cycle.rewardId = null;
    logAudit({ actorId, actorRole, customerId: sale.customerId, saleId: sale.id, action: "REWARD_CANCELLED" });
  }

  return { ok: true, sale, cycle, invalidatedReward: reward };
}

export async function getSalesForCustomer(customerId) {
  await delay(250);
  return sales
    .filter((s) => s.customerId === customerId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function getAllSales() {
  await delay(250);
  return [...sales].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
