import { delay } from "../../lib/delay.js";
import { supabaseClient } from "../../lib/supabase/client.js";
import { loyaltyCycles, rewards, logAudit, generateId } from "../../data/mockDatabase.js";
import { callLoyaltyEdge } from "./loyaltyEdgeClient.js";

// ---------------------------------------------------------------
// rewardService — consulta de recompensas, expiración y canje.
//
// LECTURAS (getRewardsForCard y derivadas):
//   * Con Supabase configurado → datos REALES desde `rewards`.
//   * Sin Supabase → fallback DEV/demo sobre mockDatabase.
//
// CANJE:
//   * REAL → loyalty-engine Edge Function → redeem_reward RPC.
//     La Edge resuelve actorId/actorRole desde la sesión y
//     public.profiles; nunca se reciben desde el frontend.
//   * DEMO → mockDatabase.
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
    .filter(
      (r) =>
        r.derivedStatus === "redeemed" ||
        r.derivedStatus === "expired" ||
        r.derivedStatus === "cancelled",
    )
    .sort(
      (a, b) =>
        new Date(b.redeemedAt || b.expiresAt || b.earnedAt) -
        new Date(a.redeemedAt || a.expiresAt || a.earnedAt),
    );
}

// ---------------------------------------------------------------
// Canje desde Staff.
//
// REAL:
//   redeemReward({ rewardId })
//   → loyalty-engine { operation: "redeem", rewardId }
//
// DEMO:
//   redeemReward({ cardId, actorId, actorRole })
//   → mockDatabase
// ---------------------------------------------------------------
export async function redeemReward({ rewardId, cardId, actorId, actorRole }) {
  // REAL: el rewardId viene directamente del lookup de loyalty-engine.
  // El actor se resuelve server-side mediante el JWT de Staff.
  if (supabaseClient) {
    if (!rewardId) {
      return {
        ok: false,
        error: "No se encontró el identificador de la recompensa.",
      };
    }

    const result = await callLoyaltyEdge({
      operation: "redeem",
      rewardId,
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.message || "La recompensa no se pudo canjear.",
        code: result.code,
        retriable: result.retriable,
      };
    }

    return result;
  }

  // DEMO: conservar comportamiento actual del mock.
  await delay(400);

  const cardCycles = loyaltyCycles.filter((cy) => cy.cardId === cardId);

  const cycle = cardCycles.find((cy) => {
    if (cy.status !== "completed" || !cy.rewardId) return false;

    const reward = rewards.find((r) => r.id === cy.rewardId);
    return reward && deriveStatus(reward) === "available";
  });

  const reward = cycle && rewards.find((r) => r.id === cycle.rewardId);

  if (!reward) {
    return {
      ok: false,
      error: "Esta tarjeta no tiene una recompensa disponible.",
    };
  }

  if (deriveStatus(reward) === "expired") {
    return {
      ok: false,
      error: "Esta recompensa ya venció.",
    };
  }

  reward.status = "redeemed";
  reward.redeemedAt = new Date().toISOString();
  reward.redeemedBy = actorId;

  logAudit({
    actorId,
    actorRole,
    action: "REWARD_REDEEMED",
  });

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

  return {
    ok: true,
    reward,
    newCycle,
  };
}