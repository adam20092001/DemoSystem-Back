import {
  AccountingSourceType,
  AccountingSystemKey,
  PaymentMethodAccountingDestination,
  Prisma,
} from '@prisma/client';

/**
 * Comando interno de AccountingEngine.postSaleRecognition() (Fase 8,
 * Bloque B). No es un DTO HTTP: sin decoradores de class-validator, no se
 * construye en ningún controller (no existe ninguno todavía). Los cuatro
 * montos ya son exactamente los persistidos/por persistir en Sale — nunca
 * se recalculan aquí. `postedAt` es el instante factual del evento de
 * negocio (Sale.confirmedAt), nunca `new Date()` dentro del motor: el
 * llamador lo fija explícitamente (plan final aprobado, §23).
 */
export interface PostSaleRecognitionCommand {
  saleId: string;
  saleNumber: string;
  subtotal: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
  postedAt: Date;
  actorUserId: string;
  ipAddress: string | null;
}

/**
 * Comando interno de AccountingEngine.postPaymentCollection(). `saleNumber`
 * viaja explícito (el motor nunca consulta Sale/Payment por sí mismo: no
 * abre transacción ni inyecta PrismaService) únicamente para construir la
 * descripción del asiento. `postedAt` es Payment.paidAt, el mismo instante
 * ya persistido para el pago — nunca un instante independiente.
 *
 * `accountingDestination` (Ticket C, Bloque C3) reemplaza al antiguo
 * `method: PaymentMethod`: el llamador (PaymentEngine) ya resolvió el
 * PaymentMethod dinámico y le pasa aquí ÚNICAMENTE su
 * accountingDestination (CASH|BANK) — AccountingEngine nunca conoce el
 * concepto de "método de pago" ni consulta `payment_methods` por sí mismo.
 */
export interface PostPaymentCollectionCommand {
  paymentId: string;
  saleNumber: string;
  accountingDestination: PaymentMethodAccountingDestination;
  amount: Prisma.Decimal;
  postedAt: Date;
  actorUserId: string;
  ipAddress: string | null;
}

/**
 * Comando interno de AccountingEngine.reverseOriginalForSource() (plan
 * final aprobado, §22): API orientada a la fuente de negocio, no al id del
 * AccountingEntry — el llamador (PaymentEngine/SalesService) conoce
 * naturalmente su Sale/Payment, nunca tiene por qué consultar el asiento
 * contable primero. `sourceNumber` es siempre el número NV de la venta
 * (tanto para revertir un asiento de venta como uno de cobro), usado
 * exclusivamente para la descripción del asiento REVERSAL.
 */
export interface ReverseOriginalForSourceCommand {
  sourceType: AccountingSourceType;
  sourceId: string;
  sourceNumber: string;
  postedAt: Date;
  actorUserId: string;
  ipAddress: string | null;
}

/**
 * Comando interno de AccountingEngine.postManualEntry() (Fase A4.4).
 * `draftId` es el `ManualJournalDraft.id` — se usa tal cual como
 * `AccountingEntry.sourceId` (sourceType=MANUAL), reutilizando el mismo
 * polimorfismo sin FK ya usado por SALE/PAYMENT. A diferencia de los dos
 * comandos de arriba, `accountingDateOnly` es una fecha YA explícita
 * (elegida por el ACCOUNTANT/ADMIN al crear el borrador), nunca derivada
 * de un instante — y `lines` referencia cuentas por `accountId` real,
 * nunca por `systemKey` (el ACCOUNTANT elige la cuenta directamente del
 * plan de cuentas, A4.3).
 */
export interface PostManualEntryCommand {
  draftId: string;
  description: string;
  accountingDateOnly: string;
  lines: {
    accountId: string;
    debitAmount: Prisma.Decimal;
    creditAmount: Prisma.Decimal;
  }[];
  actorUserId: string;
  ipAddress: string | null;
}

/**
 * Comando interno de AccountingEngine.postPurchaseRecognition() (Fase
 * A5.2a). `purchaseInvoiceId` es el `PurchaseInvoice.id` — se usa tal cual
 * como `AccountingEntry.sourceId` (sourceType=PURCHASE), mismo polimorfismo
 * sin FK que SALE/PAYMENT/MANUAL. `accountingDateOnly` es SIEMPRE explícita
 * (elegida por quien registra la factura), mismo criterio que
 * PostManualEntryCommand — nunca derivada de un instante como SALE/PAYMENT.
 * `lines` llega YA resuelto por `AccountingSystemKey` (nunca por
 * `accountId` elegido a mano, a diferencia de PostManualEntryCommand): el
 * reconocimiento de compra es un evento sistemático — el destino contable
 * de cada línea lo decide `purchasePurpose` vía un mapeo fijo
 * (PURCHASE_PURPOSE_TO_SYSTEM_KEY en purchase-invoice-calculator.ts), nunca
 * un `accountId` discrecional.
 */
export interface PostPurchaseRecognitionCommand {
  purchaseInvoiceId: string;
  description: string;
  accountingDateOnly: string;
  lines: {
    systemKey: AccountingSystemKey;
    debitAmount: Prisma.Decimal;
    creditAmount: Prisma.Decimal;
  }[];
  actorUserId: string;
  ipAddress: string | null;
}

/**
 * Comando interno de AccountingEngine.postPurchaseReceiptReclassification()
 * (Fase A5.2b). `purchaseReceiptId` es el `PurchaseReceipt.id` — se usa tal
 * cual como `AccountingEntry.sourceId` (sourceType=PURCHASE_RECEIPT), mismo
 * polimorfismo sin FK que el resto del dominio. A diferencia de
 * PostPurchaseRecognitionCommand (sistemático, resuelto por
 * AccountingSystemKey), `lines` llega YA resuelto por `accountId` real —
 * mismo criterio que PostManualEntryCommand: PurchaseReceiptsService ya
 * decidió, cuenta por cuenta, cuál es de tránsito
 * (Account.receiptReclassificationTargetAccountId) y verificó que esa
 * cuenta de origen coincide exactamente con la que el asiento ORIGINAL de
 * la factura realmente debitó — AccountingEngine nunca vuelve a resolver
 * por systemKey aquí, para no reclasificar desde una cuenta que el
 * systemKey pueda haber reasignado después de confirmar la factura.
 * Opcional por diseño: este comando SOLO se construye y envía cuando al
 * menos una línea recibida requiere reclasificación; si ninguna la
 * requiere, PurchaseReceiptsService simplemente nunca llama a este método.
 */
export interface PostPurchaseReceiptReclassificationCommand {
  purchaseReceiptId: string;
  description: string;
  accountingDateOnly: string;
  lines: {
    accountId: string;
    debitAmount: Prisma.Decimal;
    creditAmount: Prisma.Decimal;
  }[];
  actorUserId: string;
  ipAddress: string | null;
}

/**
 * Comando interno de AccountingEngine.postSupplierPaymentCollection() (Fase
 * A5.3). `supplierPaymentId` es el `SupplierPayment.id` — se usa tal cual
 * como `AccountingEntry.sourceId` (sourceType=SUPPLIER_PAYMENT). HÍBRIDO
 * deliberado entre los dos estilos de resolución ya existentes:
 * `liabilityLines` llega YA resuelto por `accountId` real (mismo criterio
 * que PostManualEntryCommand/PostPurchaseReceiptReclassificationCommand) —
 * SupplierPaymentsService ya agrupó cada factura pagada por la cuenta de
 * pasivo que su asiento PURCHASE original REALMENTE acreditó, nunca por el
 * mapeo VIGENTE de ACCOUNTS_PAYABLE; `accountingDestination` en cambio SÍ
 * se resuelve por `AccountingSystemKey` DENTRO del motor (mismo criterio
 * sistemático que PostPaymentCollectionCommand, Fase 7/Ticket C): CASH/BANK
 * son cuentas de sistema originales, un invariante de despliegue (500 si
 * falta), nunca una decisión histórica por factura. `accountingDateOnly`
 * es SIEMPRE explícita (elegida por quien registra el pago), mismo
 * criterio que PostManualEntryCommand/PostPurchaseRecognitionCommand.
 */
export interface PostSupplierPaymentCollectionCommand {
  supplierPaymentId: string;
  description: string;
  accountingDateOnly: string;
  accountingDestination: PaymentMethodAccountingDestination;
  liabilityLines: {
    accountId: string;
    amount: Prisma.Decimal;
  }[];
  actorUserId: string;
  ipAddress: string | null;
}

/**
 * Comando interno de AccountingEngine.postCogsRecognition() (Fase A6.2).
 * `saleId` es el `Sale.id` — se usa tal cual como `AccountingEntry.sourceId`
 * (sourceType=COGS), una tupla (sourceType, sourceId) DISTINTA de
 * (SALE, Sale.id): coexiste sin conflicto con el asiento de reconocimiento
 * de ingresos de la misma venta. HÍBRIDO, mismo criterio exacto que
 * PostSupplierPaymentCollectionCommand pero invertido: el lado DÉBITO
 * (costo de ventas) se resuelve por `AccountingSystemKey` DENTRO del motor
 * (COST_OF_GOODS_SOLD, 409 si no está configurado — mismo criterio que
 * PURCHASE_*, nunca el 500 de las 6 cuentas de sistema originales); el
 * lado CRÉDITO (`inventoryLines`) llega YA resuelto por `accountId` real —
 * SalesService ya verificó, producto por producto, cuál es la ÚNICA cuenta
 * histórica de inventario que respalda el pool valorizado vigente
 * (InventoryValuationEngine/cogs-account-resolver.ts), nunca el mapeo
 * VIGENTE de PURCHASE_RESALE_INVENTORY por sí solo. `postedAt` es el mismo
 * instante factual de la venta (Sale.confirmedAt) — periodo/fecha contable
 * derivados de él, igual criterio que PostSaleRecognitionCommand, nunca una
 * fecha explícita como los comandos de compra/pago a proveedor.
 */
export interface PostCogsRecognitionCommand {
  saleId: string;
  saleNumber: string;
  postedAt: Date;
  inventoryLines: {
    accountId: string;
    amount: Prisma.Decimal;
  }[];
  actorUserId: string;
  ipAddress: string | null;
}
