// ---------------------------------------------------------------
// Adaptador mínimo. Hoy solo existe el registro manual (Staff
// captura el monto a mano). El motor de fidelización
// (salesService.registerSale) no sabe ni le importa de dónde vino
// la venta — solo consume la forma normalizada de abajo.
//
// Cuando conectemos Loyverse, agregamos LoyverseSalesAdapter con la
// misma forma (normalizeSale) traduciendo su payload/webhook
// (receipt_id, total_money, customer_id de Loyverse, etc.) a esto
// mismo. No se implementa todavía: no tenemos acceso real a la
// cuenta/API, y el prompt es explícito en no construirlo a ciegas.
// ---------------------------------------------------------------

export const ManualSalesAdapter = {
  source: "manual",
  normalizeSale(input) {
    return {
      customerId: input.customerId,
      cardId: input.cardId,
      branchId: input.branchId,
      amount: input.amount,
      paymentMethod: input.paymentMethod,
      employeeId: input.employeeId,
      // En manual no hay un id externo real; si no se provee uno,
      // salesService.registerSale genera un identificador interno.
      externalSaleId: input.externalSaleId || null,
    };
  },
};

// export const LoyverseSalesAdapter = { source: "loyverse", normalizeSale(webhookPayload) { ... } };
// — futuro, no implementado.
