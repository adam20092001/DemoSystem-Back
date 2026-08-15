import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentCancellationSource,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  deriveSalePaymentSummary,
  SalePaymentSummary,
} from '../sales/sale-calculator';
import { PAYMENT_SAFE_SELECT, toSafePayment } from './mappers/payment.mapper';
import {
  assertReferenceRequiredForMethod,
  assertValidPaymentAmountShape,
} from './payment-calculator';
import {
  CancelAllActivePaymentsCommand,
  CancelPaymentCommand,
  RegisterPaymentCommand,
} from './types/payment-command';
import { SafePayment } from './types/safe-payment';

/** Fila mínima devuelta por el lock de un pago específico (cancel()). */
interface LockedPaymentRow {
  id: string;
  saleId: string;
  status: PaymentStatus;
}

/**
 * Único propietario de la escritura de Payment y de su AuditLog (mismo
 * criterio que StockMovementEngine, Fase 3). No inyecta PrismaService ni
 * abre transacción propia: `tx` es siempre la transacción del llamador
 * (PaymentsService para pagos posteriores/anulación manual; SalesService
 * para el pago inicial y la anulación en cascada al anular una venta).
 * Nunca actualiza Sale.paidAmount/balanceDue/paymentStatus por sí mismo
 * salvo a través del método explícito recalculateSaleSummary(): register()/
 * cancel()/cancelAllActiveForSale() dejan la política de resumen al
 * llamador, que ya sostiene el lock `Sale FOR UPDATE`.
 */
@Injectable()
export class PaymentEngine {
  constructor(private readonly auditService: AuditService) {}

  /**
   * Crea un Payment ACTIVE y audita exactamente una vez. No actualiza el
   * resumen de la venta: el llamador decide cuándo llamar a
   * recalculateSaleSummary() (o, en la creación inicial de una venta, ya
   * calculó el resumen final antes del INSERT de Sale).
   */
  async register(
    tx: Prisma.TransactionClient,
    command: RegisterPaymentCommand,
  ): Promise<SafePayment> {
    assertValidPaymentAmountShape(command.amount);
    assertReferenceRequiredForMethod(command.method, command.reference);

    const created = await tx.payment.create({
      data: {
        saleId: command.saleId,
        method: command.method,
        amount: command.amount,
        reference: command.reference,
        status: PaymentStatus.ACTIVE,
        paidAt: new Date(),
        createdByUserId: command.actorUserId,
      },
      select: PAYMENT_SAFE_SELECT,
    });

    await this.auditService.record({
      userId: command.actorUserId,
      module: 'PAYMENTS',
      action: AuditAction.PAYMENT_REGISTERED,
      entityType: 'Payment',
      entityId: created.id,
      description: `Pago registrado para la venta ${command.saleNumber}`,
      metadata: {
        saleId: command.saleId,
        saleNumber: command.saleNumber,
        method: command.method,
      },
      ipAddress: command.ipAddress,
      client: tx,
    });

    return toSafePayment(created);
  }

  /** Suma de Payment.amount ACTIVE para una venta. 0 si no hay ninguno. Nunca actualiza Sale. */
  async sumActiveForSale(
    tx: Prisma.TransactionClient,
    saleId: string,
  ): Promise<Prisma.Decimal> {
    const result = await tx.payment.aggregate({
      where: { saleId, status: PaymentStatus.ACTIVE },
      _sum: { amount: true },
    });
    return result._sum.amount ?? new Prisma.Decimal(0);
  }

  /**
   * Recalcula paidAmount/balanceDue/paymentStatus de una venta ACTIVE a
   * partir de SUM(Payment ACTIVE) — nunca aritmética incremental (viejo +
   * monto / viejo - monto). Precondición: el llamador ya sostiene
   * `Sale FOR UPDATE` en esta MISMA transacción `tx` (este método no toma
   * ningún lock adicional ni abre una transacción propia). No toca status/
   * deliveryStatus/campos de cliente/campos de anulación/total: solo las
   * tres columnas de resumen de pago.
   */
  async recalculateSaleSummary(
    tx: Prisma.TransactionClient,
    saleId: string,
    total: Prisma.Decimal,
  ): Promise<SalePaymentSummary> {
    const activeSum = await this.sumActiveForSale(tx, saleId);
    const summary = deriveSalePaymentSummary(total, activeSum);

    await tx.sale.update({
      where: { id: saleId },
      data: {
        paidAmount: summary.paidAmount,
        balanceDue: summary.balanceDue,
        paymentStatus: summary.paymentStatus,
      },
    });

    return summary;
  }

  /**
   * Anulación MANUAL de un único pago. El propio motor bloquea la fila
   * (SELECT ... FOR UPDATE por id+saleId): garantiza que el pago pertenece
   * a la venta indicada y que queda serializado frente a cualquier otra
   * mutación concurrente sobre el mismo pago. No actualiza el resumen de la
   * venta: el llamador invoca recalculateSaleSummary() a continuación.
   */
  async cancel(
    tx: Prisma.TransactionClient,
    command: CancelPaymentCommand,
  ): Promise<SafePayment> {
    const rows = await tx.$queryRaw<LockedPaymentRow[]>(Prisma.sql`
      SELECT id, sale_id AS "saleId", status
      FROM payments
      WHERE id = ${command.paymentId}::uuid AND sale_id = ${command.saleId}::uuid
      FOR UPDATE
    `);
    const locked = rows[0];
    if (locked === undefined) {
      throw new NotFoundException('El pago no existe');
    }
    if (locked.status === PaymentStatus.CANCELLED) {
      throw new ConflictException('El pago ya está anulado');
    }

    const updated = await tx.payment.update({
      where: { id: command.paymentId },
      data: {
        status: PaymentStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledByUserId: command.actorUserId,
        cancellationSource: PaymentCancellationSource.MANUAL,
        cancellationReason: command.reason,
      },
      select: PAYMENT_SAFE_SELECT,
    });

    await this.auditService.record({
      userId: command.actorUserId,
      module: 'PAYMENTS',
      action: AuditAction.PAYMENT_CANCELLED,
      entityType: 'Payment',
      entityId: updated.id,
      description: `Pago anulado de la venta ${command.saleNumber}`,
      metadata: {
        saleId: command.saleId,
        saleNumber: command.saleNumber,
        previousStatus: PaymentStatus.ACTIVE,
        cancellationSource: PaymentCancellationSource.MANUAL,
      },
      ipAddress: command.ipAddress,
      client: tx,
    });

    return toSafePayment(updated);
  }

  /**
   * Usado EXCLUSIVAMENTE por SalesService.cancel() dentro de su propia
   * transacción de anulación de venta. Anula todos los Payment ACTIVE de la
   * venta (los ya CANCELLED se ignoran, sin auditoría duplicada), en orden
   * determinista paidAt ASC, id ASC. Nunca actualiza el resumen de la venta
   * (Sale.paidAmount/balanceDue/paymentStatus quedan congelados —
   * responsabilidad exclusiva de SalesService, que NO llama a
   * recalculateSaleSummary() en este flujo). Cero pagos ACTIVE es un no-op
   * válido que retorna un arreglo vacío.
   */
  async cancelAllActiveForSale(
    tx: Prisma.TransactionClient,
    command: CancelAllActivePaymentsCommand,
  ): Promise<SafePayment[]> {
    const activeRows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id
      FROM payments
      WHERE sale_id = ${command.saleId}::uuid AND status = 'ACTIVE'
      ORDER BY paid_at ASC, id ASC
      FOR UPDATE
    `);

    const cancelled: SafePayment[] = [];
    for (const row of activeRows) {
      const updated = await tx.payment.update({
        where: { id: row.id },
        data: {
          status: PaymentStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledByUserId: command.actorUserId,
          cancellationSource: PaymentCancellationSource.SALE_CANCELLATION,
          cancellationReason: null,
        },
        select: PAYMENT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: command.actorUserId,
        module: 'PAYMENTS',
        action: AuditAction.PAYMENT_CANCELLED,
        entityType: 'Payment',
        entityId: updated.id,
        description: `Pago anulado automáticamente por anulación de la venta ${command.saleNumber}`,
        metadata: {
          saleId: command.saleId,
          saleNumber: command.saleNumber,
          previousStatus: PaymentStatus.ACTIVE,
          cancellationSource: PaymentCancellationSource.SALE_CANCELLATION,
        },
        ipAddress: command.ipAddress,
        client: tx,
      });

      cancelled.push(toSafePayment(updated));
    }

    return cancelled;
  }
}
