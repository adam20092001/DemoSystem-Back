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
// CUSTOMER_CREDIT_ENABLED/CUSTOMER_CREDIT_DISABLED se agregan en NR-02A:
// CustomersService.setCreditEnabled() es su único emisor, exclusivo de
// ADMIN (PATCH /customers/:id/credit). Mismo criterio que
// PAYMENT_METHOD_ACTIVATED/DEACTIVATED: un PATCH que no cambia el valor
// efectivo es un no-op y no genera ninguna de las dos filas. El cliente
// genérico "Público general" nunca las genera (rechazado con 409, mismo
// criterio que el resto de mutaciones de Customer).
// ACCOUNT_ se agregan en la Fase A1 (PCGE): ChartOfAccountsService es su
// único emisor. CREATED al crear una cuenta nueva del plan de cuentas
// (nace ACTIVE). UPDATED cubre cualquier PATCH que NO cambie `status`
// (name/parentId/type/isPostable, individualmente o combinados) — mismo
// criterio de no-op real que PAYMENT_METHOD_UPDATED: un PATCH sin cambios
// efectivos no genera ninguna fila. ACTIVATED/DEACTIVATED cubren un PATCH
// cuyo `status` sí transiciona, igual criterio que
// PAYMENT_METHOD_ACTIVATED/DEACTIVATED (única acción para esa petición,
// el resto de cambios viaja en el mismo metadata). SYSTEM_KEY_REASSIGNED
// es una acción propia, deliberadamente distinta de UPDATED: mueve un
// AccountingSystemKey de una cuenta a otra (capacidad técnica de A1.3,
// sin ninguna reasignación real activada todavía) — un evento crítico
// que afecta qué cuenta resolverá AccountingEngine para TODOS los
// asientos nuevos de ese systemKey a partir de ese instante, así que
// amerita su propia fila en vez de confundirse con una edición cualquiera.
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
  // Fase A6.1: eventos de valorización de inventario (solo cuando
  // Product.valuationMethod está configurado) — ADICIONALES a
  // INVENTORY_ENTRY_CREATED/INVENTORY_EXIT_CREATED, nunca en su lugar.
  INVENTORY_VALUATION_RECORDED = 'INVENTORY_VALUATION_RECORDED',
  INVENTORY_VALUATION_REVERSED = 'INVENTORY_VALUATION_REVERSED',
  CUSTOMER_CREATED = 'CUSTOMER_CREATED',
  CUSTOMER_UPDATED = 'CUSTOMER_UPDATED',
  CUSTOMER_ACTIVATED = 'CUSTOMER_ACTIVATED',
  CUSTOMER_DEACTIVATED = 'CUSTOMER_DEACTIVATED',
  CUSTOMER_BLOCKED = 'CUSTOMER_BLOCKED',
  CUSTOMER_UNBLOCKED = 'CUSTOMER_UNBLOCKED',
  CUSTOMER_STAGE_CHANGED = 'CUSTOMER_STAGE_CHANGED',
  CUSTOMER_CREDIT_ENABLED = 'CUSTOMER_CREDIT_ENABLED',
  CUSTOMER_CREDIT_DISABLED = 'CUSTOMER_CREDIT_DISABLED',
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
  // Ticket B post-MVP (Caja). HISTÓRICAS: el módulo de Caja fue retirado
  // (Eliminación de Caja, Bloque C2) y ya nada emite estas 5 acciones; se
  // conservan solo para leer/filtrar las filas de auditoría existentes.
  // Bloque B2: apertura de caja.
  CASH_SESSION_OPENED = 'CASH_SESSION_OPENED',
  // Ticket B post-MVP, Bloque B3 — flujo de cierre/descuadre/aprobación/
  // rechazo. CASH_SESSION_CLOSED:
  // cierre exacto (differenceAmount=0), directo, sin revisor.
  // CASH_SESSION_CLOSING_REQUESTED: cierre con descuadre, transición a
  // PENDING_APPROVAL. CASH_SESSION_DISCREPANCY_APPROVED:
  // PENDING_APPROVAL -> CLOSED por un revisor (nunca el propio dueño).
  // CASH_SESSION_DISCREPANCY_REJECTED: PENDING_APPROVAL -> OPEN; el
  // snapshot de cierre rechazado se limpia de CashSession, así que esta
  // fila de auditoría es la ÚNICA evidencia histórica que sobrevive de ese
  // intento (nunca un estado REJECTED propio de CashSession).
  CASH_SESSION_CLOSED = 'CASH_SESSION_CLOSED',
  CASH_SESSION_CLOSING_REQUESTED = 'CASH_SESSION_CLOSING_REQUESTED',
  CASH_SESSION_DISCREPANCY_APPROVED = 'CASH_SESSION_DISCREPANCY_APPROVED',
  CASH_SESSION_DISCREPANCY_REJECTED = 'CASH_SESSION_DISCREPANCY_REJECTED',
  ACCOUNT_CREATED = 'ACCOUNT_CREATED',
  ACCOUNT_UPDATED = 'ACCOUNT_UPDATED',
  ACCOUNT_ACTIVATED = 'ACCOUNT_ACTIVATED',
  ACCOUNT_DEACTIVATED = 'ACCOUNT_DEACTIVATED',
  ACCOUNT_SYSTEM_KEY_REASSIGNED = 'ACCOUNT_SYSTEM_KEY_REASSIGNED',
  // Fase A2.1/A2.6. AccountingPeriodsService es su único emisor: la
  // auto-creación implícita de un periodo dentro de
  // AccountingEngine.resolvePeriodAndAssignNumber() nunca audita por sí
  // misma (ya queda evidenciada por el ACCOUNTING_ENTRY_POSTED del asiento
  // que la disparó) — solo las acciones EXPLÍCITAS de ADMIN sobre el ciclo
  // de vida del periodo se auditan aquí.
  ACCOUNTING_PERIOD_OPENED = 'ACCOUNTING_PERIOD_OPENED',
  ACCOUNTING_PERIOD_CLOSED = 'ACCOUNTING_PERIOD_CLOSED',
  ACCOUNTING_PERIOD_REOPENED = 'ACCOUNTING_PERIOD_REOPENED',
  // Fase A4.8. ManualJournalEntriesService es su único emisor. CREATED/
  // UPDATED son eventos del propio BORRADOR (nunca tocan AccountingEntry);
  // POSTED/REVERSED se auditan ADEMÁS del ACCOUNTING_ENTRY_POSTED/
  // ACCOUNTING_ENTRY_REVERSED genérico que AccountingEngine ya emite por
  // su cuenta (mismo criterio dual que PAYMENT_REGISTERED/
  // PAYMENT_CANCELLED junto a su propio asiento) — capturan el id del
  // BORRADOR, que el evento genérico del motor nunca conoce.
  MANUAL_JOURNAL_DRAFT_CREATED = 'MANUAL_JOURNAL_DRAFT_CREATED',
  MANUAL_JOURNAL_DRAFT_UPDATED = 'MANUAL_JOURNAL_DRAFT_UPDATED',
  MANUAL_JOURNAL_POSTED = 'MANUAL_JOURNAL_POSTED',
  MANUAL_JOURNAL_REVERSED = 'MANUAL_JOURNAL_REVERSED',
  // Fase A5.1 (maestro de proveedores). SuppliersService es su único
  // emisor. Sin ningún vínculo a Compras/Cuentas por Pagar/AccountingEngine
  // todavía (esta fase es exclusivamente maestro de datos).
  SUPPLIER_CREATED = 'SUPPLIER_CREATED',
  SUPPLIER_UPDATED = 'SUPPLIER_UPDATED',
  SUPPLIER_ACTIVATED = 'SUPPLIER_ACTIVATED',
  SUPPLIER_DEACTIVATED = 'SUPPLIER_DEACTIVATED',
  // Fase A5.2a (facturas de compra universales). PurchaseInvoicesService es
  // su único emisor. Nunca se audita descriptionSnapshot de línea ni el
  // nombre legal del proveedor (PII/negocio) — solo metadatos estructurales,
  // mismo criterio que SUPPLIER_*/MANUAL_JOURNAL_*.
  PURCHASE_INVOICE_CREATED = 'PURCHASE_INVOICE_CREATED',
  PURCHASE_INVOICE_UPDATED = 'PURCHASE_INVOICE_UPDATED',
  PURCHASE_INVOICE_CONFIRMED = 'PURCHASE_INVOICE_CONFIRMED',
  PURCHASE_INVOICE_CANCELLED = 'PURCHASE_INVOICE_CANCELLED',
  // Fase A5.2b (recepciones físicas de mercadería). PurchaseReceiptsService
  // es su único emisor. Nunca audita costo/monto de factura — solo
  // identificadores, cantidad de líneas y si disparó reclasificación
  // contable (booleano), mismo criterio que el resto del dominio.
  PURCHASE_RECEIPT_CREATED = 'PURCHASE_RECEIPT_CREATED',
  PURCHASE_RECEIPT_CANCELLED = 'PURCHASE_RECEIPT_CANCELLED',
  // Fase A5.3 (pagos a proveedores). SupplierPaymentsService es su único
  // emisor. Nunca audita el detalle de asignaciones por factura — solo
  // identificadores/conteos/montos agregados, mismo criterio que el resto
  // del dominio.
  SUPPLIER_PAYMENT_REGISTERED = 'SUPPLIER_PAYMENT_REGISTERED',
  SUPPLIER_PAYMENT_CANCELLED = 'SUPPLIER_PAYMENT_CANCELLED',
  // Fase B1 (operaciones de importación). ImportOperationsService/
  // ImportShipmentsService son sus únicos emisores. Nunca registra ningún
  // efecto de inventario/contable (B1 no genera ninguno) — solo
  // identificadores/estados/conteos, mismo criterio que el resto del
  // dominio.
  IMPORT_OPERATION_CREATED = 'IMPORT_OPERATION_CREATED',
  IMPORT_OPERATION_UPDATED = 'IMPORT_OPERATION_UPDATED',
  IMPORT_OPERATION_COMPLETED = 'IMPORT_OPERATION_COMPLETED',
  IMPORT_OPERATION_CANCELLED = 'IMPORT_OPERATION_CANCELLED',
  IMPORT_SHIPMENT_CREATED = 'IMPORT_SHIPMENT_CREATED',
  IMPORT_SHIPMENT_UPDATED = 'IMPORT_SHIPMENT_UPDATED',
  IMPORT_SHIPMENT_DEPARTED = 'IMPORT_SHIPMENT_DEPARTED',
  IMPORT_SHIPMENT_ARRIVED = 'IMPORT_SHIPMENT_ARRIVED',
  IMPORT_SHIPMENT_CANCELLED = 'IMPORT_SHIPMENT_CANCELLED',
  // Fase B2 (gastos de importación y asignación de costo).
  // ImportExpensesService es su único emisor. Nunca registra monto/moneda
  // ni el detalle de líneas asignadas — solo identificadores/estados/
  // conteos, mismo criterio que el resto del dominio. B2 nunca audita un
  // efecto contable/de inventario porque nunca genera ninguno.
  IMPORT_EXPENSE_CREATED = 'IMPORT_EXPENSE_CREATED',
  IMPORT_EXPENSE_UPDATED = 'IMPORT_EXPENSE_UPDATED',
  IMPORT_EXPENSE_FINALIZED = 'IMPORT_EXPENSE_FINALIZED',
  IMPORT_EXPENSE_CANCELLED = 'IMPORT_EXPENSE_CANCELLED',
  IMPORT_EXPENSE_ALLOCATED = 'IMPORT_EXPENSE_ALLOCATED',
  // Fase B3 (vínculos de recepción física de importación).
  // ImportReceiptLinksService es su único emisor. Nunca registra ningún
  // efecto de inventario/contable (B3 nunca genera ninguno en esta fase:
  // solo vincula y previsualiza) — solo identificadores/cantidades.
  IMPORT_RECEIPT_LINK_CREATED = 'IMPORT_RECEIPT_LINK_CREATED',
  IMPORT_RECEIPT_LINK_CANCELLED = 'IMPORT_RECEIPT_LINK_CANCELLED',
}
