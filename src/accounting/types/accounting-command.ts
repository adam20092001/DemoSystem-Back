import { AccountingSourceType, PaymentMethod, Prisma } from '@prisma/client';

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
 */
export interface PostPaymentCollectionCommand {
  paymentId: string;
  saleNumber: string;
  method: PaymentMethod;
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
