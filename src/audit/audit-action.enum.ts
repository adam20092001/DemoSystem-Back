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
 * de campos modificados. SEQUENCE_UPDATED se agrega en la Fase 10, Bloque D:
 * SequenceAdminService es su único emisor, dentro de la misma transacción que
 * el PATCH de un DocumentSequence (prefix/padding/currentNumber). Mismo
 * criterio que CONFIGURATION_UPDATED (changedFields + oldValues/newValues,
 * solo campos realmente cambiados, sin auditoría si el PATCH es un no-op),
 * más `documentType` como campo plano adicional para identificar QUOTE/SALE
 * sin depender de entityId. DocumentSequenceService.next() (generación
 * automática de correlativos) nunca audita: esta acción solo la emite la
 * administración manual expuesta en el Bloque D. ACTIVE_ROLE_SWITCHED se
 * agrega en KAN-18, Bloque B: AuthService.switchRole() es su único emisor.
 * Representa un evento de sesión/autenticación (activeRole del JWT de ESTA
 * sesión), nunca una mutación persistente de User/UserRole — por eso nunca
 * reutiliza USER_UPDATED. Solo se registra cuando el rol activo realmente
 * cambia: una solicitud de cambio al mismo rol ya activo es un no-op
 * explícito y no genera esta acción.
 */
// ELECTRONIC_DOCUMENT_ se agregan en la Fase 11, Bloque C:
// ElectronicDocumentsService es su único emisor. CREATED se registra dentro
// de la MISMA transacción de creación del documento fiscal (número ya
// asignado). ACCEPTED/REJECTED/SUBMISSION_FAILED se registran dentro de la
// transacción corta que persiste cada resultado del proveedor. No existe
// una acción SUBMITTED separada (decisión cerrada, Bloque 11C §32): a
// diferencia de PAYMENT_/SALE_, el tránsito interno CREATED/SUBMISSION_FAILED
// -> SUBMITTED es un detalle de orquestación, no un evento fiscal
// externamente significativo — solo importan la creación del documento y su
// resolución final (o el fallo técnico que la impide).
// PAYMENT_METHOD_ se agregan en el Ticket C post-MVP, Bloque C2:
// PaymentMethodsService es su único emisor. CREATED al crear un método
// dinámico (nace `active: true`). UPDATED cubre cualquier PATCH que NO
// cambie `active` (name/requiresReference/affectsCashDrawer/
// accountingDestination/sortOrder, individualmente o combinados) — un PATCH
// que no modifica ningún valor efectivo no genera auditoría (mismo criterio
// que CONFIGURATION_UPDATED). ACTIVATED/DEACTIVATED cubren un PATCH cuyo
// `active` sí transiciona (false->true / true->false): esa es SIEMPRE la
// única acción emitida para esa petición, incluso si otros campos cambiaron
// en el mismo PATCH (sus cambios viajan en `changedFields`/`oldValues`/
// `newValues` de esa misma fila) — nunca una fila ACTIVATED/DEACTIVATED más
// una fila UPDATED redundante para la misma petición. Sin
// PAYMENT_METHOD_REORDERED: reordenar es sortOrder cambiando por PATCH,
// cubierto por UPDATED, igual que cualquier otro campo simple.
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
  SEQUENCE_UPDATED = 'SEQUENCE_UPDATED',
  ACTIVE_ROLE_SWITCHED = 'ACTIVE_ROLE_SWITCHED',
  ELECTRONIC_DOCUMENT_CREATED = 'ELECTRONIC_DOCUMENT_CREATED',
  ELECTRONIC_DOCUMENT_ACCEPTED = 'ELECTRONIC_DOCUMENT_ACCEPTED',
  ELECTRONIC_DOCUMENT_REJECTED = 'ELECTRONIC_DOCUMENT_REJECTED',
  ELECTRONIC_DOCUMENT_SUBMISSION_FAILED = 'ELECTRONIC_DOCUMENT_SUBMISSION_FAILED',
  PAYMENT_METHOD_CREATED = 'PAYMENT_METHOD_CREATED',
  PAYMENT_METHOD_UPDATED = 'PAYMENT_METHOD_UPDATED',
  PAYMENT_METHOD_ACTIVATED = 'PAYMENT_METHOD_ACTIVATED',
  PAYMENT_METHOD_DEACTIVATED = 'PAYMENT_METHOD_DEACTIVATED',
}
