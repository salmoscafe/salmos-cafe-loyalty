import { delay } from "../../lib/delay.js";
import { supabaseClient } from "../../lib/supabase/client.js";
import {
  sales,
  customers,
  branches,
  loyaltyCycles,
  rewards,
  MIN_SALE_AMOUNT,
  REQUIRED_VISITS,
  generateId,
  logAudit,
} from "../../data/mockDatabase.js";
import { addVisit } from "../loyalty/loyaltyService.js";
import { compareVisitsDesc } from "./saleOrdering.js";

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

// ------------------------------------------------------------------
// Detalle del ticket para la vista Cliente (Actividad → recibo).
// ------------------------------------------------------------------

// Folio corto del ticket para el recibo. La fuente es el último
// segmento de external_sale_id (el receipt_number de Loyverse:
// `loyverse_receipt_<store>_<receipt_number>` → `<receipt_number>`).
function buildFolio(externalSaleId, id) {
  if (typeof externalSaleId === "string" && externalSaleId !== "") {
    const parts = externalSaleId.split("_");
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return id ? String(id).slice(0, 8) : "";
}

export async function getSalesForCustomer(customerId) {
  await delay(250);

  // Supabase configurado → la fuente real es `loyalty_visits` (Loyverse
  // receipt → register_visit → referencias del cliente). RLS 0002: el
  // cliente solo lee lo suyo (customer_id = customers.id).
  if (supabaseClient) {
    const { data: visits, error } = await supabaseClient
      .from("loyalty_visits")
      .select("*")
      .eq("customer_id", customerId)
      .order("visit_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw error;

    const { data: cycles, error: cyclesError } = await supabaseClient
      .from("loyalty_cycles")
      .select("id, required_visits")
      .eq("customer_id", customerId);
    if (cyclesError) throw cyclesError;

    const requiredByCycle = new Map((cycles || []).map((c) => [c.id, c.required_visits]));
    const progressByVisit = computeCycleProgress(visits || []);
    // Orden del servicio: más reciente → más antigua por la fecha REAL
    // del ticket (receipt_date), created_at solo como fallback mientras
    // 0010 no esté desplegada (ver saleOrdering.js).
    return (visits || [])
      .map((visit) =>
        toClientSale(visit, {
          cycleVisits: progressByVisit.get(visit.id),
          requiredVisits: requiredByCycle.get(visit.cycle_id) ?? REQUIRED_VISITS,
        })
      )
      .sort(compareVisitsDesc);
  }

  return sales
    .filter((s) => s.customerId === customerId)
    .map(enrichMockSale)
    .sort(compareVisitsDesc);
}

// Progreso histórico por visita dentro de su ciclo: cuántas visitas
// ACTIVAS había en ese ciclo al momento de la visita (incluyéndola si
// es activa). Se deriva de loyalty_visits — el esquema real no guarda
// contador. Clave: visit.id → progreso (after).
export function computeCycleProgress(visits) {
  const byCycle = new Map();
  for (const visit of visits) {
    const list = byCycle.get(visit.cycle_id) || [];
    list.push(visit);
    byCycle.set(visit.cycle_id, list);
  }

  const progressByVisit = new Map();
  for (const list of byCycle.values()) {
    // Orden cronológico REAL de la visita: receipt_date (fecha del
    // ticket de Loyverse, 0010) → visit_date (fecha de negocio) →
    // created_at (sincronización, fallback). Misma prioridad que
    // saleOrdering.visitSortTimestamp: el recibo mandaba aunque la
    // sincronización se registre después.
    const ordered = [...list].sort((a, b) => {
      const ta = new Date(a.receipt_date ?? a.visit_date ?? a.created_at).getTime();
      const tb = new Date(b.receipt_date ?? b.visit_date ?? b.created_at).getTime();
      return ta - tb || (a.created_at ? a.created_at.localeCompare(b.created_at || "") : 0);
    });
    let running = 0;
    for (const visit of ordered) {
      if (visit.status === "active") running += 1;
      progressByVisit.set(visit.id, running);
    }
  }
  return progressByVisit;
}

function enrichMockSale(sale) {
  const cycle = loyaltyCycles.find((cy) => cy.id === sale.cycleId) || null;
  const cycleVisits = sale.status === "completed" ? computeMockProgressFor(sale) : null;
  return {
    id: sale.id,
    customerId: sale.customerId,
    amount: sale.amount,
    status: sale.status,
    cancelledAt: sale.cancelledAt,
    externalSaleId: sale.externalSaleId,
    cycleId: sale.cycleId,
    triggeredRewardId: sale.triggeredRewardId,
    createdAt: sale.createdAt,
    paymentMethod: sale.paymentMethod || null,
    branchId: sale.branchId,
    employeeId: sale.employeeId,
    items: Array.isArray(sale.items) ? sale.items : null,
    receiptDate: sale.createdAt,
    verseId: sale.verseId ?? null,
    folio: buildFolio(sale.externalSaleId, sale.id),
    cycleVisits,
    requiredVisits: cycle ? cycle.requiredVisits : REQUIRED_VISITS,
  };
}

function computeMockProgressFor(sale) {
  return sales.filter(
    (s) => s.cycleId === sale.cycleId && s.status === "completed" && new Date(s.createdAt) <= new Date(sale.createdAt)
  ).length;
}

// Shape cliente que Activity/ReceiptPrinter esperan. `loyalty_visits` no
// guarda método de pago → paymentMethod = null ("No disponible" en el
// recibo); store_id mapea a branchId. No se inventa información. El
// detalle del ticket (items/receipt_date/porgreso) viene de 0010 cuando
// existe; NULL en visitas previas.
export function toClientSale(visit, ctx = {}) {
  return {
    id: visit.id,
    customerId: visit.customer_id,
    amount: visit.amount,
    status: visit.status,
    cancelledAt: visit.cancelled_at,
    externalSaleId: visit.external_sale_id,
    cycleId: visit.cycle_id,
    triggeredRewardId: visit.triggered_reward_id,
    createdAt: visit.created_at,
    paymentMethod: null,
    branchId: visit.store_id,
    employeeId: visit.employee_id,
    items: Array.isArray(visit.items) ? visit.items : null,
    receiptDate: visit.receipt_date || visit.created_at || null,
    visitDate: visit.visit_date || null,
    verseId: visit.verse_id ?? null,
    folio: buildFolio(visit.external_sale_id, visit.id),
    cycleVisits: ctx.cycleVisits ?? null,
    requiredVisits: ctx.requiredVisits ?? REQUIRED_VISITS,
  };
}

export async function getAllSales() {
  await delay(250);
  return [...sales].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
