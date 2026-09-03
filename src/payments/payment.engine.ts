import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountingSourceType,
  PaymentCancellationSource,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { AccountingEngine } from '../accounting/accounting.engine';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PaymentMethodReader } from '../payment-methods/payment-method-reader.service';
import {
  deriveSalePaymentSummary,
  SalePaymentSummary,
} from '../sales/sale-calculator';
import { PAYMENT_SAFE_SELECT, toSafePayment } from './mappers/payment.mapper';
import {
  assertReferenceRequiredForMethod,
  assertValidPaymentAmountShape,
  normalizePaymentMethodCode,
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
 * llamador, que ya sostiene el lock `Sale FOR UPDATE`. Desde la Fase 8,
 * Bloque B, compone AccountingEngine dentro del MISMO tx para el
 * reconocimiento/reversión contable de cada cobro — AccountingEngine sigue
 * siendo el único escritor de AccountingEntry/AccountingEntryLine y de su
 * auditoría ACCOUNTING_ENTRY_*; PaymentEngine nunca las escribe él mismo.
 *
 * Ticket C, Bloque C3 (CONTRACT): register() es el ÚNICO punto del dominio
 * que resuelve un método de pago dinámico — SIEMPRE contra `tx` (la misma
 * transacción que crea el Payment), nunca contra una conexión Prisma
 * global independiente (PaymentMethodReader recibe `tx` explícitamente en
 * cada llamada). Esto es lo que hace posible que "resolver -> validar ->
 * crear Payment -> postear contabilidad -> auditar" ocurra como una única
 * unidad atómica: si el método se desactivara entre la resolución y el
 * commit, no hay ventana — todo corre bajo el mismo snapshot transaccional
 * de PostgreSQL (READ COMMITTED, el nivel por defecto de Prisma: la fila
 * ya se lee tal cual está en el instante de la consulta dentro de la
 * transacción en curso, sin necesitar un lock de fila explícito ni mucho
 * menos un lock de tabla completa — no existe otro código en todo el
 * dominio que escriba `payment_methods` fuera de PaymentMethodsService,
 * que corre sus propias mutaciones en su propia transacción corta; una
 * carrera real entre "ADMIN desactiva" y "operador cobra" se resuelve
 * simplemente por cuál transacción confirma primero, mismo criterio de
 * tolerancia que el resto del dominio ya aplica a Product/Category
 * mientras se confirma una Venta).
 */
@Injectable()
export class PaymentEngine {
  constructor(
    private readonly auditService: AuditService,
    private readonly accountingEngine: AccountingEngine,
    private readonly paymentMethodReader: PaymentMethodReader,
  ) {}

  /**
   * Crea un Payment ACTIVE, postea su asiento contable de cobro y audita
   * exactamente una vez. No actualiza el resumen de la venta: el llamador
   * decide cuándo llamar a recalculateSaleSummary() (o, en la creación
   * inicial de una venta, ya calculó el resumen final antes del INSERT de
   * Sale). Un único instante `paidAt` se genera y se reutiliza tanto para
   * Payment.paidAt como para AccountingEntry.postedAt del asiento de cobro
   * (plan final aprobado, §23/§28): nunca dos instantes independientes
   * para el mismo hecho financiero.
   *
   * Resolución de método (Ticket C, Bloque C3): `command.method` es el
   * código crudo tal como llegó del llamador (ya sea el `method` HTTP del
   * DTO, o el mismo valor propagado desde SalesService). Se normaliza
   * (trim+mayúsculas) y se resuelve contra `payment_methods` DENTRO de
   * esta misma transacción — código inexistente -> 404; código existente
   * pero inactivo -> 409; nunca se especial-casa un código legacy por
   * existir en el antiguo enum: la única regla es `active`.
   */
  async register(
    tx: Prisma.TransactionClient,
    command: RegisterPaymentCommand,
  ): Promise<SafePayment> {
    assertValidPaymentAmountShape(command.amount);

    const normalizedCode = normalizePaymentMethodCode(command.method);
    const method = await this.paymentMethodReader.findByCode(
      normalizedCode,
      tx,
    );
    if (method === null) {
      throw new NotFoundException(
        `No existe un método de pago con code "${normalizedCode}"`,
      );
    }
    if (!method.active) {
      throw new ConflictException(
        `El método de pago "${normalizedCode}" está inactivo`,
      );
    }
    assertReferenceRequiredForMethod(
      method.requiresReference,
      command.reference,
    );

    const paidAt = new Date();

    const created = await tx.payment.create({
      data: {
        saleId: command.saleId,
        amount: command.amount,
        reference: command.reference,
        status: PaymentStatus.ACTIVE,
        paidAt,
        createdByUserId: command.actorUserId,
        // Snapshot histórico (Ticket C, Bloque C3): congelado en el
        // instante de creación, nunca vuelto a leer/recalcular después.
        // Un ADMIN editando name/affectsCashDrawer del método dinámico
        // más tarde jamás reescribe estas cuatro columnas.
        paymentMethodId: method.id,
        paymentMethodCode: method.code,
        paymentMethodName: method.name,
        paymentMethodAffectsCashDrawer: method.affectsCashDrawer,
      },
      select: PAYMENT_SAFE_SELECT,
    });

    await this.accountingEngine.postPaymentCollection(tx, {
      paymentId: created.id,
      saleNumber: command.saleNumber,
      // accountingDestination YA resuelto aquí (Bloque C3): AccountingEngine
      // nunca vuelve a consultar PaymentMethod por sí mismo. Nunca se
      // snapshotea en Payment (§15 del plan aprobado): ese hecho contable
      // ya queda inmutable, por separado, en AccountingEntryLine.
      accountingDestination: method.accountingDestination,
      amount: command.amount,
      postedAt: paidAt,
      actorUserId: command.actorUserId,
      ipAddress: command.ipAddress,
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
        method: method.code,
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
   * venta: el llamador invoca recalculateSaleSummary() a continuación. Un
   * único instante `cancelledAt` se genera y se reutiliza tanto para
   * Payment.cancelledAt como para AccountingEntry.postedAt del asiento de
   * reversión (plan final aprobado, §22/§29).
   *
   * Ticket C, Bloque C3: la anulación NUNCA vuelve a resolver el
   * PaymentMethod actual ni evalúa su estado `active` — revierte el asiento
   * contable ORIGINAL ya posteado en su momento (resuelto entonces, nunca
   * releído), exactamente igual que antes del Bloque C3. Un método
   * desactivado después de cobrar sigue permitiendo anular ese cobro.
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

    const cancelledAt = new Date();

    const updated = await tx.payment.update({
      where: { id: command.paymentId },
      data: {
        status: PaymentStatus.CANCELLED,
        cancelledAt,
        cancelledByUserId: command.actorUserId,
        cancellationSource: PaymentCancellationSource.MANUAL,
        cancellationReason: command.reason,
      },
      select: PAYMENT_SAFE_SELECT,
    });

    await this.accountingEngine.reverseOriginalForSource(tx, {
      sourceType: AccountingSourceType.PAYMENT,
      sourceId: command.paymentId,
      sourceNumber: command.saleNumber,
      postedAt: cancelledAt,
      actorUserId: command.actorUserId,
      ipAddress: command.ipAddress,
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
   * venta (los ya CANCELLED se ignoran, sin auditoría ni reversión contable
   * duplicada), en orden determinista paidAt ASC, id ASC. Nunca actualiza
   * el resumen de la venta (Sale.paidAmount/balanceDue/paymentStatus
   * quedan congelados — responsabilidad exclusiva de SalesService, que NO
   * llama a recalculateSaleSummary() en este flujo). Cero pagos ACTIVE es
   * un no-op válido que retorna un arreglo vacío. `command.cancelledAt` es
   * el instante ÚNICO de la operación de anulación de venta completa (plan
   * final aprobado, §30/§37): se reutiliza para Payment.cancelledAt Y para
   * el postedAt de cada reversión contable de pago — nunca un instante
   * independiente por pago. Mismo criterio del Bloque C3 que cancel(): no
   * vuelve a resolver el PaymentMethod actual.
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
          cancelledAt: command.cancelledAt,
          cancelledByUserId: command.actorUserId,
          cancellationSource: PaymentCancellationSource.SALE_CANCELLATION,
          cancellationReason: null,
        },
        select: PAYMENT_SAFE_SELECT,
      });

      await this.accountingEngine.reverseOriginalForSource(tx, {
        sourceType: AccountingSourceType.PAYMENT,
        sourceId: row.id,
        sourceNumber: command.saleNumber,
        postedAt: command.cancelledAt,
        actorUserId: command.actorUserId,
        ipAddress: command.ipAddress,
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
