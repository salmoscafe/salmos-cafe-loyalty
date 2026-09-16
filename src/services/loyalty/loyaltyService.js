import { delay } from "../../lib/delay.js";
import { supabaseClient } from "../../lib/supabase/client.js";
import {
  cards,
  loyaltyCycles,
  rewards,
  REQUIRED_VISITS,
  REWARD_MAX_VALUE,
  REWARD_EXPIRY_MONTHS,
  generateId,
  logAudit,
} from "../../data/mockDatabase.js";

// ---------------------------------------------------------------
// loyaltyService — dueño del concepto de "ciclo de lealtad".
//
// LECTURAS del cliente (>getCardForCustomer, getCycleHistory):
//   * Con Supabase configurado → datos REALES (RLS 0002: solo ve lo suyo vía
//     customers.auth_user_id = auth.uid()). El progreso del ciclo se DERIVA
//     de loyalty_visits activas (el esquema real no guarda contador).
//     `getCardForCustomer` espera el customers.id real (session.customer.profileId).
//   * Sin Supabase → fallback DEV/demo sobre mockDatabase (modo actual).
//
// IMPORTANTE: `addVisit` es de uso INTERNO. Solo debe ser llamado
// por salesService.registerSale(), nunca directamente desde una
// pantalla. No se expone a través de services/index.js por esta
// razón. Todas las reglas de VALIDACIÓN (monto mínimo, límite
// diario, idempotencia) viven en salesService — addVisit asume que
// la venta ya es válida y solo se encarga de sumar 1 y, si
// corresponde, generar la recompensa.
// ---------------------------------------------------------------

// ------------------------------------------------------------------
// Lectura REAL (Supabase). La tarjeta física no existe como tabla en el
// esquema: es la fila `customers` (cardNumber = customer_code). El ciclo
// vigente y sus visitas vienen de loyalty_cycles + loyalty_visits.
// ------------------------------------------------------------------

// Todos los ciclos del cliente con su conteo de visitas ACTIVAS derivado.
async function fetchCyclesWithVisits(customerId) {
  const { data: cycles, error: cyclesError } = await supabaseClient
    .from("loyalty_cycles")
    .select("id, cycle_number, required_visits, status, started_at, completed_at")
    .eq("customer_id", customerId)
    .order("started_at", { ascending: false });
  if (cyclesError) throw cyclesError;
  if (!cycles || !cycles.length) return [];

  const { data: visits, error: visitsError } = await supabaseClient
    .from("loyalty_visits")
    .select("cycle_id")
    .in("cycle_id", cycles.map((c) => c.id))
    .eq("status", "active");
  if (visitsError) throw visitsError;

  const activeByCycle = (visits || []).reduce((acc, visit) => {
    acc[visit.cycle_id] = (acc[visit.cycle_id] || 0) + 1;
    return acc;
  }, {});

  return cycles.map((cycle) => ({
    id: cycle.id,
    customerId,
    cycleNumber: cycle.cycle_number,
    requiredVisits: cycle.required_visits,
    status: cycle.status,
    startedAt: cycle.started_at,
    completedAt: cycle.completed_at,
    rewardId: null,
    visits: activeByCycle[cycle.id] || 0,
  }));
}

function toClientCard(customer) {
  return {
    id: customer.id,
    customerId: customer.id,
    cardNumber: customer.customer_code,
    status: "active",
  };
}

export async function getCardForCustomer(customerId) {
  await delay(250);

  if (supabaseClient) {
    const { data: customer, error } = await supabaseClient
      .from("customers")
      .select("id, customer_code")
      .eq("id", customerId)
      .maybeSingle();
    if (error) throw error;
    if (!customer) return { card: null, cycle: null };
    const cycles = await fetchCyclesWithVisits(customer.id);
    return { card: toClientCard(customer), cycle: currentCycleForCard(cycles) };
  }

  const card = cards.find((c) => c.customerId === customerId) || null;
  if (!card) return { card: null, cycle: null };
  const cardCycles = loyaltyCycles.filter((cy) => cy.cardId === card.id);
  return { card, cycle: currentCycleForCard(cardCycles) };
}

// Ciclo "vigente" de una tarjeta: el activo normalmente. Entre que un
// ciclo llega a 7/7 (status -> "completed") y Staff confirma el canje,
// no existe ningún ciclo activo todavía — y la tarjeta debe seguir
// mostrando el 7/7 desbloqueado, no resetear a 0/7. Por eso cae al
// ciclo más reciente cuando no hay uno activo.
export function currentCycleForCard(cardCycles) {
  const active = cardCycles.find((cy) => cy.status === "active");
  const mostRecent = [...cardCycles].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0];
  return active || mostRecent || null;
}

export async function getCycleHistory(cardId) {
  await delay(250);
  if (supabaseClient) return fetchCyclesWithVisits(cardId);
  return loyaltyCycles
    .filter((cy) => cy.cardId === cardId)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

function addMonths(isoString, months) {
  const d = new Date(isoString);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

// Efecto secundario de una venta válida. Devuelve el ciclo actualizado
// y, si corresponde, la recompensa recién generada (con su vencimiento
// a REWARD_EXPIRY_MONTHS ya fijado).
export function addVisit({ cardId, actorId, actorRole }) {
  let cycle = loyaltyCycles.find((cy) => cy.cardId === cardId && cy.status === "active");

  if (!cycle) {
    cycle = {
      id: generateId("cyc"),
      cardId,
      visits: 0,
      requiredVisits: REQUIRED_VISITS,
      status: "active",
      startedAt: new Date().toISOString(),
      completedAt: null,
      rewardId: null,
    };
    loyaltyCycles.push(cycle);
  }

  cycle.visits += 1;
  logAudit({ actorId, actorRole, action: "VISIT_ADDED" });

  let newReward = null;
  if (cycle.visits >= cycle.requiredVisits) {
    cycle.status = "completed";
    cycle.completedAt = new Date().toISOString();
    const earnedAt = new Date().toISOString();
    newReward = {
      id: generateId("rwd"),
      cycleId: cycle.id,
      label: "Café gratis",
      maxValue: REWARD_MAX_VALUE,
      status: "available",
      earnedAt,
      expiresAt: addMonths(earnedAt, REWARD_EXPIRY_MONTHS),
      redeemedAt: null,
      redeemedBy: null,
    };
    rewards.push(newReward);
    cycle.rewardId = newReward.id;
    logAudit({ actorId, actorRole, action: "REWARD_EARNED" });
  }

  return { cycle, newReward };
}

export { REQUIRED_VISITS };
