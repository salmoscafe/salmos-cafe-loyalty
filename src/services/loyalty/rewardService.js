import { delay } from "../../lib/delay.js";
import { supabaseClient } from "../../lib/supabase/client.js";
import { loyaltyCycles, rewards, logAudit, generateId } from "../../data/mockDatabase.js";

// ---------------------------------------------------------------
// rewardService — consulta de recompensas, expiración y canje.
//
// LECTURAS (getRewardsForCard y derivadas):
//   * Con Supabase configurado → datos REALES desde `rewards` (RLS 0002:
//     el cliente solo lee lo suyo). `card.id` en modo real es el
//     customers.id (~customer_id de rewards).
//   * Sin Supabase → fallback DEV/demo sobre mockDatabase (modo actual).
//
// Con respecto al canje: NO lo dispara el cliente por sí solo — la
// pantalla de Cliente solo puede pedir "mostrar mi QR para canjear".
// Quien confirma el canje (rewardService.redeemReward) es Staff, igual
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

function toClientReward(reward) {
  return {
    id: reward.id,
    customerId: reward.customer_id,
    cycleId: reward.cycle_id,
    label: reward.label,
    maxValue: reward.max_value,
    status: reward.status,
    earnedAt: reward.earned_at,
    expiresAt: reward.expires_at,
    redeemedAt: reward.redeemed_at,
    redeemedBy: reward.redeemed_by,
    createdAt: reward.created_at,
  };
}

export async function getRewardsForCard(cardId) {
  await delay(250);

  if (supabaseClient) {
    const { data, error } = await supabaseClient
      .from("rewards")
      .select("*")
      .eq("customer_id", cardId)
      .order("earned_at", { ascending: false });
    if (error) throw error;
    return (data || []).map((reward) => withDerivedStatus(toClientReward(reward)));
  }

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
