import { delay } from "../../lib/delay.js";
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
// IMPORTANTE: `addVisit` es de uso INTERNO. Solo debe ser llamado
// por salesService.registerSale(), nunca directamente desde una
// pantalla. No se expone a través de services/index.js por esta
// razón. Todas las reglas de VALIDACIÓN (monto mínimo, límite
// diario, idempotencia) viven en salesService — addVisit asume que
// la venta ya es válida y solo se encarga de sumar 1 y, si
// corresponde, generar la recompensa.
// ---------------------------------------------------------------

export async function getCardForCustomer(customerId) {
  await delay(250);
  const card = cards.find((c) => c.customerId === customerId) || null;
  if (!card) return { card: null, cycle: null };
  const cardCycles = loyaltyCycles.filter((cy) => cy.cardId === card.id);
  return { card, cycle: currentCycleForCard(cardCycles) };
}

// Ciclo "vigente" de una tarjeta: el activo normalmente. Entre que un
// ciclo llega a 8/8 (status -> "completed") y Staff confirma el canje,
// no existe ningún ciclo activo todavía — y la tarjeta debe seguir
// mostrando el 8/8 desbloqueado, no resetear a 0/8. Por eso cae al
// ciclo más reciente cuando no hay uno activo.
export function currentCycleForCard(cardCycles) {
  const active = cardCycles.find((cy) => cy.status === "active");
  const mostRecent = [...cardCycles].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0];
  return active || mostRecent || null;
}

export async function getCycleHistory(cardId) {
  await delay(250);
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
