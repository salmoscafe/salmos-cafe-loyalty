import { delay } from "../../lib/delay.js";
import { tickets, sales, generateId, logAudit } from "../../data/mockDatabase.js";

// ---------------------------------------------------------------
// ticketService — comprobante de compra de Salmos Café.
// NO es un CFDI. `createTicket` y `sendByEmail` son llamados por
// salesService como parte de registerSale(); no se exponen para
// uso suelto desde la UI.
// ---------------------------------------------------------------

export function createTicket({ saleId, sentToEmail }) {
  const ticket = {
    id: generateId("tkt"),
    saleId,
    ticketNumber: `SC-${String(100000 + tickets.length + 1).slice(-6)}`,
    sentToEmail,
    sentAt: null,
  };
  tickets.push(ticket);
  logAudit({ actorId: "system", actorRole: "system", saleId, action: "TICKET_CREATED" });
  return ticket;
}

export function sendByEmail(ticket, { actorId, actorRole }) {
  ticket.sentAt = new Date().toISOString();
  logAudit({ actorId, actorRole, saleId: ticket.saleId, action: "TICKET_SENT" });
  return ticket;
}

export async function getTicketForSale(saleId) {
  await delay(200);
  return tickets.find((t) => t.saleId === saleId) || null;
}

export async function getTicketsForCustomer(customerId) {
  await delay(250);
  const saleIds = sales.filter((s) => s.customerId === customerId).map((s) => s.id);
  return tickets.filter((t) => saleIds.includes(t.saleId));
}
