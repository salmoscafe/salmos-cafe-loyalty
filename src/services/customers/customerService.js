import { delay } from "../../lib/delay.js";
import { customers, cards, loyaltyCycles, generateId } from "../../data/mockDatabase.js";
import { currentCycleForCard } from "../loyalty/loyaltyService.js";

// ---------------------------------------------------------------
// customerService — lecturas relacionadas al cliente. Nunca
// escribe visitas ni recompensas (eso vive en loyaltyService /
// salesService / rewardService).
// ---------------------------------------------------------------

// DEV BRIDGE (temporal): asegura que el cliente real de Supabase también
// exista en el mock de lealtad (customers + cards), claveado por el UUID
// de auth_user_id. Es lo único que mantiene funcionando Home / Rewards /
// Activity / Profile sobre el motor de fidelización mock mientras el
// catálogo de lealtad no migre a Supabase. Se elimina junto con
// mockDatabase el día de esa migración; no es código de producción.
export function ensureLoyaltyProfile(profile) {
  const customerId = profile.auth_user_id;
  if (!customers.some((c) => c.id === customerId)) {
    customers.push({
      id: customerId,
      name: profile.name || "Cliente Salmos",
      email: profile.email || "",
      emailVerified: Boolean(profile.email_verified),
      phone: profile.phone || "",
      createdAt: profile.created_at || new Date().toISOString(),
      customerCode: profile.customer_code,
      loyverseCustomerId: profile.loyverse_customer_id,
      loyverseSyncStatus: profile.loyverse_sync_status,
    });
  }
  if (!cards.some((k) => k.customerId === customerId)) {
    cards.push({
      id: generateId("card"),
      customerId,
      cardNumber: profile.customer_code,
      status: "active",
    });
  }
}

export async function getCustomerById(customerId) {
  await delay(200);
  return customers.find((c) => c.id === customerId) || null;
}

// Usado por Staff al escanear el QR del cliente. Hoy el "token"
// es simplemente el número de tarjeta; mañana será un token
// firmado que el backend resuelve a un customerId sin exponer
// datos sensibles en el propio QR.
export async function findCustomerByToken(token) {
  await delay(500);
  const card = cards.find((c) => c.cardNumber === token || c.id === token);
  if (!card) return { ok: false, error: "No encontramos ninguna tarjeta con ese código." };
  const customer = customers.find((c) => c.id === card.customerId);
  const cardCycles = loyaltyCycles.filter((cy) => cy.cardId === card.id);
  return { ok: true, customer, card, cycle: currentCycleForCard(cardCycles) };
}

export async function searchCustomers(query) {
  await delay(300);
  const q = query.trim().toLowerCase();
  if (!q) return customers;
  return customers.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      c.phone.replace(/\s/g, "").includes(q.replace(/\s/g, ""))
  );
}
