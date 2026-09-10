// ---------------------------------------------------------------
// Punto único de import para las pantallas: `import { ... } from
// "../../services"`. Deliberadamente NO reexporta
// `loyaltyService.addVisit` — esa función es interna a
// salesService.registerSale() y no debe quedar al alcance de
// ningún screen (cliente, staff o admin).
//
// Estructura por dominio: services/<rol>/<servicio>. Todo lo que
// vive aquí tiene una sola responsabilidad; el barrel es la única
// fachada que conocen las pantallas.
// ---------------------------------------------------------------

export * as authService from "./auth/authService.js";
export * as customerService from "./customers/customerService.js";
export * as salesService from "./sales/salesService.js";
export * as rewardService from "./loyalty/rewardService.js";
export * as ticketService from "./sales/ticketService.js";
export * as staffService from "./staff/staffService.js";
export * as adminService from "./admin/adminService.js";
export { ManualSalesAdapter } from "./sales/salesAdapters.js";

// loyaltyService se reexporta solo con sus lecturas seguras.
export {
  getCardForCustomer,
  getCycleHistory,
  REQUIRED_VISITS,
} from "./loyalty/loyaltyService.js";