/**
 * Acciones auditables del sistema. Las de USER_ se usan desde la Fase 1,
 * Bloque B; LOGIN_SUCCESS y LOGIN_FAILED desde el Bloque C. Las de
 * CATEGORY_ y UNIT_ se usan desde la Fase 2, Bloque B; las de PRODUCT_
 * desde el Bloque C; las de PRODUCT_IMAGE_ y PRODUCT_PRIMARY_IMAGE_CHANGED
 * desde el Bloque D. Las de INVENTORY_ se usan desde la Fase 3, Bloque B,
 * resueltas internamente por StockMovementEngine (nunca por el DTO/
 * controller): no existen acciones separadas para SALE/SALE_CANCELLATION
 * (siguen resolviéndose a INVENTORY_EXIT_CREATED/INVENTORY_ENTRY_CREATED
 * según movementType, igual que MANUAL) ni para PURCHASE/RETURN/REVERSAL,
 * fuera de alcance del MVP. Las de CUSTOMER_ se usan desde la Fase 4,
 * Bloque B; el cliente genérico "Público general" nunca las genera (todos
 * los métodos de mutación lo rechazan con 409), salvo CUSTOMER_STAGE_CHANGED,
 * que además reutiliza la Fase 6 (Bloque B) al confirmar una venta con un
 * cliente PROSPECT. Las de QUOTE_ se usan desde la Fase 5, Bloque B:
 * QUOTE_CREATED/UPDATED/ACCEPTED/REJECTED. No existe QUOTE_EXPIRED (el
 * vencimiento es un estado efectivo derivado, nunca persistido/escrito por
 * ningún método). QUOTE_CONVERTED se agrega en la Fase 6, Bloque B: la
 * conversión real (QuotesService no la implementa; SalesService la posee
 * por completo dentro de su propia transacción, ver D17 del plan aprobado).
 * Las de SALE_ se usan desde la Fase 6, Bloque B (SalesService): venta
 * directa o desde cotización (SALE_CONFIRMED, con `source` en metadata),
 * anulación (SALE_CANCELLED) y cambio de estado de entrega
 * (SALE_DELIVERY_STATUS_CHANGED). Las de PAYMENT_ se agregan en la Fase 7,
 * Bloque B: PaymentEngine es su ÚNICO emisor (nunca PaymentsService/
 * SalesService directamente) — PAYMENT_REGISTERED al crear un pago (pago
 * posterior o pago inicial embebido en la confirmación de una venta) y
 * PAYMENT_CANCELLED al anularlo, tanto en anulación MANUAL de un pago
 * individual como en la anulación automática en cascada de todos los pagos
 * ACTIVE de una venta anulada (PaymentEngine.cancelAllActiveForSale). No
 * existe SALE_PAYMENT_STATUS_CHANGED: el cambio de resumen de pago de la
 * venta es derivado de estas dos acciones, auditarlo por separado sería
 * ruido redundante. Las de ACCOUNTING_ se agregan en la Fase 8, Bloque B:
 * AccountingEngine es su ÚNICO emisor (nunca SalesService/PaymentEngine
 * directamente) — ACCOUNTING_ENTRY_POSTED al crear un asiento ORIGINAL
 * (reconocimiento de venta o cobro de pago) y ACCOUNTING_ENTRY_REVERSED al
 * crear su asiento REVERSAL. Semántica distinta de SALE_ / PAYMENT_: esas
 * describen el evento de negocio; estas describen exclusivamente el
 * registro contable derivado, sin duplicar información ya auditada.
 * CONFIGURATION_UPDATED se agrega en la Fase 10, Bloque A: ConfigurationService
 * es su único emisor, dentro de la misma transacción que el PATCH de
 * CompanySettings. Solo se registra cuando al menos un campo cambió
 * realmente (un PATCH que no modifica ningún valor no genera auditoría); la
 * metadata nunca incluye valores anteriores/nuevos de identidad de empresa
 * (nombre, dirección, teléfono, correo) — mismo criterio de evitar texto
 * libre potencialmente sensible que CUSTOMER_/QUOTE_/SALE_, solo la lista
 * de campos modificados.
 */
export enum AuditAction {
  LOGIN_SUCCESS = 'LOGIN_SUCCESS',
  LOGIN_FAILED = 'LOGIN_FAILED',
  USER_CREATED = 'USER_CREATED',
  USER_UPDATED = 'USER_UPDATED',
  USER_BLOCKED = 'USER_BLOCKED',
  USER_UNBLOCKED = 'USER_UNBLOCKED',
  PASSWORD_RESET = 'PASSWORD_RESET',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  CATEGORY_CREATED = 'CATEGORY_CREATED',
  CATEGORY_UPDATED = 'CATEGORY_UPDATED',
  CATEGORY_ACTIVATED = 'CATEGORY_ACTIVATED',
  CATEGORY_DEACTIVATED = 'CATEGORY_DEACTIVATED',
  UNIT_CREATED = 'UNIT_CREATED',
  UNIT_UPDATED = 'UNIT_UPDATED',
  UNIT_ACTIVATED = 'UNIT_ACTIVATED',
  UNIT_DEACTIVATED = 'UNIT_DEACTIVATED',
  PRODUCT_CREATED = 'PRODUCT_CREATED',
  PRODUCT_UPDATED = 'PRODUCT_UPDATED',
  PRODUCT_PRICE_CHANGED = 'PRODUCT_PRICE_CHANGED',
  PRODUCT_ACTIVATED = 'PRODUCT_ACTIVATED',
  PRODUCT_DEACTIVATED = 'PRODUCT_DEACTIVATED',
  PRODUCT_SPECIFICATION_CHANGED = 'PRODUCT_SPECIFICATION_CHANGED',
  PRODUCT_IMAGE_ADDED = 'PRODUCT_IMAGE_ADDED',
  PRODUCT_IMAGE_REMOVED = 'PRODUCT_IMAGE_REMOVED',
  PRODUCT_PRIMARY_IMAGE_CHANGED = 'PRODUCT_PRIMARY_IMAGE_CHANGED',
  INVENTORY_INITIAL_BALANCE_CREATED = 'INVENTORY_INITIAL_BALANCE_CREATED',
  INVENTORY_ENTRY_CREATED = 'INVENTORY_ENTRY_CREATED',
  INVENTORY_EXIT_CREATED = 'INVENTORY_EXIT_CREATED',
  INVENTORY_ADJUSTMENT_IN_CREATED = 'INVENTORY_ADJUSTMENT_IN_CREATED',
  INVENTORY_ADJUSTMENT_OUT_CREATED = 'INVENTORY_ADJUSTMENT_OUT_CREATED',
  CUSTOMER_CREATED = 'CUSTOMER_CREATED',
  CUSTOMER_UPDATED = 'CUSTOMER_UPDATED',
  CUSTOMER_ACTIVATED = 'CUSTOMER_ACTIVATED',
  CUSTOMER_DEACTIVATED = 'CUSTOMER_DEACTIVATED',
  CUSTOMER_BLOCKED = 'CUSTOMER_BLOCKED',
  CUSTOMER_UNBLOCKED = 'CUSTOMER_UNBLOCKED',
  CUSTOMER_STAGE_CHANGED = 'CUSTOMER_STAGE_CHANGED',
  QUOTE_CREATED = 'QUOTE_CREATED',
  QUOTE_UPDATED = 'QUOTE_UPDATED',
  QUOTE_ACCEPTED = 'QUOTE_ACCEPTED',
  QUOTE_REJECTED = 'QUOTE_REJECTED',
  QUOTE_CONVERTED = 'QUOTE_CONVERTED',
  SALE_CONFIRMED = 'SALE_CONFIRMED',
  SALE_CANCELLED = 'SALE_CANCELLED',
  SALE_DELIVERY_STATUS_CHANGED = 'SALE_DELIVERY_STATUS_CHANGED',
  PAYMENT_REGISTERED = 'PAYMENT_REGISTERED',
  PAYMENT_CANCELLED = 'PAYMENT_CANCELLED',
  ACCOUNTING_ENTRY_POSTED = 'ACCOUNTING_ENTRY_POSTED',
  ACCOUNTING_ENTRY_REVERSED = 'ACCOUNTING_ENTRY_REVERSED',
  CONFIGURATION_UPDATED = 'CONFIGURATION_UPDATED',
}
