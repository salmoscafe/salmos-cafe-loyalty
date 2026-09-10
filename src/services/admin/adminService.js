import { delay } from "../../lib/delay.js";
import { customers, sales, rewards, loyaltyCycles, cards, branches } from "../../data/mockDatabase.js";
import { searchCustomers } from "../customers/customerService.js";

// ---------------------------------------------------------------
// adminService — lecturas agregadas para el dashboard y la lista
// de clientes. V1 solo implementa Dashboard + Clientes; el resto
// de pantallas de Admin quedan como stubs en la UI.
// ---------------------------------------------------------------

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
      requiredVisits: cycle?.requiredVisits ?? 8,
    };
  });
}
