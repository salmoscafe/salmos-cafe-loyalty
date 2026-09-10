import { delay } from "../../lib/delay.js";
import { loyaltyCycles, rewards, logAudit, generateId } from "../../data/mockDatabase.js";

// ---------------------------------------------------------------
// rewardService — consulta de recompensas, expiración y canje.
//
// El canje NO lo dispara el cliente por sí solo: la pantalla de
// Cliente solo puede pedir "mostrar mi QR para canjear". Quien
// confirma el canje (rewardService.redeemReward) es Staff, igual
// que confirma una venta — así queda auditado quién lo autorizó.
//
// Estado almacenado: "available" | "redeemed" | "cancelled".
// "expired" se DERIVA aquí (available + now > expiresAt) — nunca se
// escribe en el dato, así el historial conserva lo que realmente pasó
// y no dependemos de un cron para saber si algo venció.
// ---------------------------------------------------------------

function deriveStatus(reward) {
  if (reward.status === "available" && reward.expiresAt && new Date() > new Date(reward.expiresAt)) {
    return "expired";
  }
  return reward.status;
}

function withDerivedStatus(reward) {
  return { ...reward, derivedStatus: deriveStatus(reward) };
}

export async function getRewardsForCard(cardId) {
  await delay(250);
  const cycleIds = loyaltyCycles.filter((cy) => cy.cardId === cardId).map((cy) => cy.id);
  return rewards.filter((r) => cycleIds.includes(r.cycleId)).map(withDerivedStatus);
}

export async function getCurrentReward(cardId) {
  await delay(200);
  const list = await getRewardsForCard(cardId);
  return list.find((r) => r.derivedStatus === "available") || null;
}

export async function getPastRewards(cardId) {
  await delay(200);
  const list = await getRewardsForCard(cardId);
  return list
    .filter((r) => r.derivedStatus === "redeemed" || r.derivedStatus === "expired" || r.derivedStatus === "cancelled")
    .sort((a, b) => new Date(b.redeemedAt || b.expiresAt || b.earnedAt) - new Date(a.redeemedAt || a.expiresAt || a.earnedAt));
}

// Llamado desde el flujo de Staff, nunca desde el flujo de Cliente.
export async function redeemReward({ cardId, actorId, actorRole }) {
  await delay(400);
  const cardCycles = loyaltyCycles.filter((cy) => cy.cardId === cardId);
  // No basta con el primer ciclo "completed" — con más de un ciclo
  // cerrado en la tarjeta, hay que ubicar específicamente el que tiene
  // la recompensa TODAVÍA disponible (ni redimida, ni vencida).
  const cycle = cardCycles.find((cy) => {
    if (cy.status !== "completed" || !cy.rewardId) return false;
    const reward = rewards.find((r) => r.id === cy.rewardId);
    return reward && deriveStatus(reward) === "available";
  });
  const reward = cycle && rewards.find((r) => r.id === cycle.rewardId);

  if (!reward) {
    return { ok: false, error: "Esta tarjeta no tiene una recompensa disponible." };
  }
  if (deriveStatus(reward) === "expired") {
    return { ok: false, error: "Esta recompensa ya venció." };
  }

  reward.status = "redeemed";
  reward.redeemedAt = new Date().toISOString();
  reward.redeemedBy = actorId;
  logAudit({ actorId, actorRole, action: "REWARD_REDEEMED" });

  // Abre el siguiente ciclo inmediatamente.
  const newCycle = {
    id: generateId("cyc"),
    cardId,
    visits: 0,
    requiredVisits: cycle.requiredVisits,
    status: "active",
    startedAt: new Date().toISOString(),
    completedAt: null,
    rewardId: null,
  };
  loyaltyCycles.push(newCycle);

  return { ok: true, reward, newCycle };
}
