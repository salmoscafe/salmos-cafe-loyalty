// Suite mínima con el test runner nativo de Node (node:test + node:assert).
// No hay red disponible en este entorno para instalar Vitest/Jest — por
// eso se usa lo que ya trae Node 18+. Corre con: node --test tests/
//
// Cada test usa su PROPIO cliente/tarjeta (fixtures aislados empujados
// directamente al mock) para no contaminarse entre sí, ya que el mock
// es estado mutable a nivel de módulo.

import test from "node:test";
import assert from "node:assert/strict";

import { customers, cards, loyaltyCycles, rewards, sales, generateId } from "../src/data/mockDatabase.js";
import * as loyaltyService from "../src/services/loyalty/loyaltyService.js";
import * as salesService from "../src/services/sales/salesService.js";
import * as rewardService from "../src/services/loyalty/rewardService.js";
import * as publicServices from "../src/services/index.js";

const BRANCH_1 = "branch_1";
const BRANCH_2 = "branch_2";
const EMPLOYEE = "emp_1";

function makeCustomer(label) {
  const customerId = generateId(`test_cus_${label}`);
  const cardId = generateId(`test_card_${label}`);
  customers.push({
    id: customerId,
    name: `Cliente ${label}`,
    email: `${label}@test.local`,
    emailVerified: true,
    phone: "+52 000 000 0000",
    createdAt: new Date().toISOString(),
  });
  cards.push({ id: cardId, customerId, cardNumber: `TEST-${label}`, status: "active" });
  return { customerId, cardId };
}

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

async function sell({ customerId, cardId, amount, branchId = BRANCH_1, externalSaleId }) {
  return salesService.registerSale({
    customerId,
    cardId,
    branchId,
    amount,
    paymentMethod: "Tarjeta",
    employeeId: EMPLOYEE,
    externalSaleId,
  });
}

// 1. $49 → no visita
test("compra menor a $50 no genera visita", async () => {
  const { customerId, cardId } = makeCustomer("t1");
  const res = await sell({ customerId, cardId, amount: 49 });
  assert.equal(res.ok, false);
  const { cycle } = await loyaltyService.getCardForCustomer(customerId);
  assert.equal(cycle, null);
});

// 2. $50 → 1 visita
test("compra de exactamente $50 genera 1 visita", async () => {
  const { customerId, cardId } = makeCustomer("t2");
  const res = await sell({ customerId, cardId, amount: 50 });
  assert.equal(res.ok, true);
  assert.equal(res.cycle.visits, 1);
});

// 3. $100 → 1 visita, no 2
test("compra de $100 genera exactamente 1 visita, no 2", async () => {
  const { customerId, cardId } = makeCustomer("t3");
  const res = await sell({ customerId, cardId, amount: 100 });
  assert.equal(res.cycle.visits, 1);
});

// 4. Dos compras válidas mismo día → máximo 1 visita
test("dos compras válidas el mismo día → máximo 1 visita", async () => {
  const { customerId, cardId } = makeCustomer("t4");
  const first = await sell({ customerId, cardId, amount: 60 });
  assert.equal(first.ok, true);
  assert.equal(first.cycle.visits, 1);

  const second = await sell({ customerId, cardId, amount: 80 });
  assert.equal(second.ok, false);
  assert.match(second.error, /ya registró una visita válida hoy/i);

  const { cycle } = await loyaltyService.getCardForCustomer(customerId);
  assert.equal(cycle.visits, 1);
});

// 5. Compras en días distintos → visitas independientes
test("compras en días distintos generan visitas independientes", async () => {
  const { customerId, cardId } = makeCustomer("t5");
  const first = await sell({ customerId, cardId, amount: 60 });
  assert.equal(first.cycle.visits, 1);

  // Retrocedemos manualmente la fecha de la venta ya registrada para
  // simular "eso fue ayer" sin necesitar mockear Date globalmente.
  first.sale.createdAt = daysAgoIso(1);

  const second = await sell({ customerId, cardId, amount: 60 });
  assert.equal(second.ok, true);
  assert.equal(second.cycle.visits, 2);
});

// 6 y 7. Visita 6 sin recompensa, visita 7 con recompensa
test("visita 6 no genera recompensa, visita 7 sí", async () => {
  const { customerId, cardId } = makeCustomer("t6");
  let lastRes;
  for (let i = 0; i < 6; i++) {
    lastRes = await sell({ customerId, cardId, amount: 60 });
    assert.equal(lastRes.ok, true);
    lastRes.sale.createdAt = daysAgoIso(30 - i); // cada una un día distinto, en el pasado
  }
  assert.equal(lastRes.cycle.visits, 6);
  assert.equal(lastRes.newReward, null);

  const seventh = await sell({ customerId, cardId, amount: 60 });
  assert.equal(seventh.cycle.visits, 7);
  assert.ok(seventh.newReward, "la 7ª visita debe generar una recompensa");
  assert.equal(seventh.newReward.status, "available");
  assert.equal(seventh.cycle.status, "completed");
});

// 8. Recompensa expira a los 3 meses
test("la recompensa expira a los 3 meses (derivado, sin cron)", async () => {
  const { customerId, cardId } = makeCustomer("t7");
  let res;
  for (let i = 0; i < 7; i++) {
    res = await sell({ customerId, cardId, amount: 60 });
    res.sale.createdAt = daysAgoIso(60 - i);
  }
  const reward = res.newReward;
  assert.ok(reward);

  let current = await rewardService.getCurrentReward(cardId);
  assert.ok(current, "todavía debe estar disponible antes de vencer");

  // Forzamos el vencimiento retrocediendo expiresAt.
  const stored = rewards.find((r) => r.id === reward.id);
  stored.expiresAt = daysAgoIso(1);

  current = await rewardService.getCurrentReward(cardId);
  assert.equal(current, null, "ya no debe aparecer como disponible");

  const past = await rewardService.getPastRewards(cardId);
  const found = past.find((r) => r.id === reward.id);
  assert.equal(found.derivedStatus, "expired");

  const redeemAttempt = await rewardService.redeemReward({ cardId, actorId: EMPLOYEE, actorRole: "staff" });
  assert.equal(redeemAttempt.ok, false);
});

// 9. Venta cancelada → visita revertida
test("cancelar una venta revierte la visita", async () => {
  const { customerId, cardId } = makeCustomer("t8");
  const res = await sell({ customerId, cardId, amount: 60 });
  assert.equal(res.cycle.visits, 1);

  const cancel = await salesService.cancelSale(res.sale.id, { actorId: EMPLOYEE, actorRole: "staff" });
  assert.equal(cancel.ok, true);
  assert.equal(cancel.cycle.visits, 0);

  const saleRecord = sales.find((s) => s.id === res.sale.id);
  assert.equal(saleRecord.status, "cancelled");
  assert.ok(saleRecord.cancelledAt);
});

// 10. Cancelar la venta que creó la visita 7 → recompensa invalidada, ciclo corregido
test("cancelar la venta de la 7ª visita invalida la recompensa y reabre el ciclo", async () => {
  const { customerId, cardId } = makeCustomer("t9");
  let res;
  for (let i = 0; i < 7; i++) {
    res = await sell({ customerId, cardId, amount: 60 });
    res.sale.createdAt = daysAgoIso(60 - i);
  }
  assert.ok(res.newReward);
  const rewardId = res.newReward.id;
  const cycleId = res.cycle.id;

  const cancel = await salesService.cancelSale(res.sale.id, { actorId: EMPLOYEE, actorRole: "staff" });
  assert.equal(cancel.ok, true);

  const reward = rewards.find((r) => r.id === rewardId);
  assert.equal(reward.status, "cancelled");

  const cycle = loyaltyCycles.find((c) => c.id === cycleId);
  assert.equal(cycle.status, "active");
  assert.equal(cycle.visits, 6);
  assert.equal(cycle.rewardId, null);
});

// 11. Recompensa ya redimida → cancelación bloqueada, nada se modifica
test("cancelar una venta cuya recompensa ya fue redimida se bloquea sin modificar nada", async () => {
  const { customerId, cardId } = makeCustomer("t10");
  let res;
  for (let i = 0; i < 7; i++) {
    res = await sell({ customerId, cardId, amount: 60 });
    res.sale.createdAt = daysAgoIso(60 - i);
  }
  const rewardId = res.newReward.id;

  const redeem = await rewardService.redeemReward({ cardId, actorId: EMPLOYEE, actorRole: "staff" });
  assert.equal(redeem.ok, true);

  const beforeCycle = { ...loyaltyCycles.find((c) => c.id === res.cycle.id) };
  const beforeReward = { ...rewards.find((r) => r.id === rewardId) };

  const cancel = await salesService.cancelSale(res.sale.id, { actorId: EMPLOYEE, actorRole: "staff" });
  assert.equal(cancel.ok, false);

  const afterCycle = loyaltyCycles.find((c) => c.id === res.cycle.id);
  const afterReward = rewards.find((r) => r.id === rewardId);
  assert.deepEqual(afterCycle, beforeCycle, "el ciclo no debe modificarse");
  assert.deepEqual(afterReward, beforeReward, "la recompensa no debe modificarse");

  const saleRecord = sales.find((s) => s.id === res.sale.id);
  assert.equal(saleRecord.status, "completed", "la venta original debe seguir intacta");
});

// 12. Misma externalSaleId → no duplica visita
test("la misma externalSaleId no genera una segunda visita", async () => {
  const { customerId, cardId } = makeCustomer("t11");
  const extId = "ext-dup-1";
  const first = await sell({ customerId, cardId, amount: 60, externalSaleId: extId });
  assert.equal(first.cycle.visits, 1);

  const second = await sell({ customerId, cardId, amount: 60, externalSaleId: extId });
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(second.sale.id, first.sale.id);

  const { cycle } = await loyaltyService.getCardForCustomer(customerId);
  assert.equal(cycle.visits, 1);
  assert.equal(sales.filter((s) => s.externalSaleId === extId).length, 1);
});

// 13. Dos sucursales → mismo ciclo del cliente
test("ventas en dos sucursales distintas comparten el mismo ciclo", async () => {
  const { customerId, cardId } = makeCustomer("t12");
  const first = await sell({ customerId, cardId, amount: 60, branchId: BRANCH_1 });
  first.sale.createdAt = daysAgoIso(1);

  const second = await sell({ customerId, cardId, amount: 60, branchId: BRANCH_2 });

  assert.equal(first.cycle.id, second.cycle.id, "debe ser el mismo ciclo sin importar la sucursal");
  assert.equal(second.cycle.visits, 2);
});

// 14. Cliente no puede modificar visitas/recompensas directamente
test("el barrel público de services no expone addVisit ni nada que mute visitas directamente", () => {
  assert.equal(publicServices.addVisit, undefined);
  assert.equal(typeof loyaltyService.addVisit, "function", "addVisit debe existir, pero solo para uso interno");
  // El único camino público para sumar una visita es registerSale.
  assert.equal(typeof publicServices.salesService.registerSale, "function");
});

// ====================================================================
// QA · REGLA DOCUMENTADA — "6 visitas acumuladas → la 7.ª visita
// genera/desbloquea la recompensa." (default/regla nueva = 7)
//
// Cobertura ya existente arriba (no se duplica):
//   * compra < $50 no genera visita                     → test 1
//   * máximo 1 visita válida por cliente por día        → test 4
//
// Casos que faltaban y se cubren aquí:
//   1) Con 6 visitas activas: sin recompensa disponible
//      (getCurrentReward === null) y ciclo sigue activo.
//   2) Registrar la visita #7: exactamente 1 recompensa,
//      available, ciclo completed, triggered_reward_id asociado.
//   3) Registrar otra visita después del 7/7: NO crea una
//      segunda recompensa del mismo ciclo; abre un ciclo nuevo.
// ====================================================================

function sellBehindDays({ customerId, cardId, amount = 60, daysAgo }) {
  return sell({ customerId, cardId, amount }).then((res) => {
    res.sale.createdAt = daysAgoIso(daysAgo);
    return res;
  });
}

test("QA · regla 7/7: con 6 visitas activas no existe recompensa disponible y el ciclo sigue activo", async () => {
  const { customerId, cardId } = makeCustomer("qa_6v");
  let lastRes;
  for (let i = 0; i < 6; i++) {
    lastRes = await sellBehindDays({ customerId, cardId, daysAgo: 30 - i });
  }
  assert.equal(lastRes.cycle.visits, 6);
  assert.equal(lastRes.newReward, null, "6 visitas no pueden devolver una recompensa");
  assert.equal(lastRes.cycle.status, "active", "con 6 visitas el ciclo debe seguir activo");

  const current = await rewardService.getCurrentReward(cardId);
  assert.equal(current, null, "con 6 visitas no debe existir recompensa disponible");
});

test("QA · regla 7/7: la 7.ª visita genera exactamente 1 recompensa available y queda asociada a esa visita", async () => {
  const { customerId, cardId } = makeCustomer("qa_7v");
  let res;
  for (let i = 0; i < 6; i++) {
    res = await sellBehindDays({ customerId, cardId, daysAgo: 30 - i });
  }

  const seventh = await sell({ customerId, cardId, amount: 60 });
  assert.equal(seventh.ok, true);
  assert.ok(seventh.newReward, "la 7ª visita debe generar una recompensa");
  assert.equal(seventh.newReward.status, "available");
  assert.equal(seventh.cycle.status, "completed", "el ciclo debe pasar a completed al llegar a 7");
  assert.equal(seventh.cycle.requiredVisits, 7, "el ciclo completado se selló con el requisito de 7 visitas");

  const rewardId = seventh.newReward.id;
  assert.equal(seventh.sale.triggeredRewardId, rewardId, "triggered_reward_id debe asociarse a la visita #7");

  const cycleRewards = rewards.filter((r) => r.cycleId === seventh.cycle.id);
  assert.equal(cycleRewards.length, 1, "debe existir EXACTAMENTE una recompensa para el ciclo completado");
  assert.equal(cycleRewards[0].status, "available");

  const current = await rewardService.getCurrentReward(cardId);
  assert.equal(current?.id, rewardId, "la recompensa disponible debe ser la generada por la 7ª visita");
});

test("QA · regla 7/7: una visita posterior al 7/7 no crea una segunda recompensa (abre ciclo nuevo)", async () => {
  const { customerId, cardId } = makeCustomer("qa_8v");
  let res;
  for (let i = 0; i < 6; i++) {
    res = await sellBehindDays({ customerId, cardId, daysAgo: 30 - i });
  }
  const seventh = await sell({ customerId, cardId, amount: 60 });
  const completedCycleId = seventh.cycle.id;
  const earnedRewardId = seventh.newReward.id;

  // La 7ª se registró hoy; la movemos a ayer para poder registrar otra
  // compra válida (máximo 1 visita/día) y observar el ciclo completado.
  seventh.sale.createdAt = daysAgoIso(1);

  const eighth = await sell({ customerId, cardId, amount: 60 });
  assert.equal(eighth.ok, true);
  assert.notEqual(eighth.cycle.id, completedCycleId, "la venta posterior debe abrir un ciclo NUEVO");
  assert.equal(eighth.cycle.visits, 1);
  assert.equal(eighth.cycle.status, "active");
  assert.equal(eighth.cycle.requiredVisits, 7, "el ciclo nuevo debe heredar el requisito de 7 visitas");

  const completedCycle = loyaltyCycles.find((c) => c.id === completedCycleId);
  assert.equal(completedCycle.status, "completed", "el ciclo 7/7 debe conservar su estado completed");

  const cycleRewards = rewards.filter((r) => r.cycleId === completedCycleId);
  assert.equal(cycleRewards.length, 1, "el ciclo 7/7 debe conservar UNA sola recompensa");
  assert.equal(cycleRewards[0].id, earnedRewardId);
  assert.equal(cycleRewards[0].status, "available", "la recompensa del ciclo 7/7 sigue available");
});
