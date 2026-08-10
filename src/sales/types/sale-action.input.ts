/**
 * Input interno compartido por las acciones de entrega (markDelivered/
 * markObserved, Bloque B): sin estado objetivo elegido por el llamador —
 * cada método de servicio implementa una única transición explícita, nunca
 * un `changeDeliveryStatus(target)` genérico (§65 del plan aprobado).
 */
export interface SaleActionInput {
  saleId: string;
  actorUserId: string;
  ipAddress?: string | null;
}

/**
 * Input interno de anulación. Se separa de SaleActionInput porque exige un
 * campo adicional (`reason`) que las acciones de entrega no tienen.
 */
export interface CancelSaleInput {
  saleId: string;
  reason: string;
  actorUserId: string;
  ipAddress?: string | null;
}
