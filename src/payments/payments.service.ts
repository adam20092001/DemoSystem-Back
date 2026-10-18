import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SaleStatus } from '@prisma/client';
import {
  endOfBusinessDayExclusiveUtc,
  isValidDateOnly,
  startOfBusinessDayUtc,
} from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import { PAYMENT_SAFE_SELECT, toSafePayment } from './mappers/payment.mapper';
import {
  normalizePaymentCancellationReason,
  normalizePaymentReference,
  parsePaymentAmount,
} from './payment-calculator';
import {
  assertCanOperateSale,
  SaleAccessRequester,
  saleReadScopeWhere,
} from '../sales/sale-access.policy';
import { PaymentEngine } from './payment.engine';
import { ListPaymentsQuery } from './types/list-payments.query';
import {
  CancelPaymentInput,
  RegisterPaymentInput,
} from './types/payment.input';
import {
  PaymentMutationResult,
  SafeSalePaymentSummary,
} from './types/payment-result';
import { SafePayment } from './types/safe-payment';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Fila mínima bloqueada de Sale, leída directamente vía Prisma (mismo criterio SalesService -> Quote: sin depender de SalesModule/SalesService). */
interface LockedSaleRow {
  id: string;
  number: string;
  status: SaleStatus;
  // P4: responsable comercial, leído bajo el mismo bloqueo para decidir la
  // propiedad (nunca Payment.createdByUserId).
  sellerId: string;
  total: Prisma.Decimal;
  customerIsGeneric: boolean;
}

/** Mensaje único de 404 del registro de pagos: venta inexistente o ajena. */
const SALE_NOT_FOUND_FOR_PAYMENT = 'La venta no existe';

/**
 * Servicio público del dominio Pagos (Bloque B: pago posterior + anulación
 * manual + listado; sin HTTP todavía). Nunca inyecta SalesService ni
 * importa SalesModule: bloquea/lee Sale directamente vía Prisma, mismo
 * precedente arquitectónico que SalesService usa para Quote (D17 de la
 * Fase 6). Todo el resumen de pago se recalcula desde
 * SUM(Payment ACTIVE) a través de PaymentEngine — nunca aritmética
 * incremental ad hoc.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentEngine: PaymentEngine,
  ) {}

  /**
   * Pago posterior sobre una venta existente. Nunca consulta Customer: la
   * elegibilidad de pago depende únicamente de Sale.status=ACTIVE (D7
   * aprobado) — una venta con deuda de un cliente que luego pasó a
   * INACTIVE/BLOCKED sigue siendo pagable.
   */
  /**
   * Permisos por vendedor (P4): solo el dueño comercial de la venta
   * (`Sale.sellerId`) o un rol sin restricción de propiedad (ADMIN) puede
   * registrar un cobro posterior. La propiedad se comprueba sobre la fila
   * ya bloqueada, ANTES de cualquier validación que pueda revelar el
   * estado de la venta (anulada, saldo) y antes de cualquier escritura:
   * una venta ajena responde el mismo 404 que una inexistente.
   * `createdByUserId` del Payment sigue siendo el actor real, nunca el
   * criterio de permiso.
   */
  async register(
    input: RegisterPaymentInput & { actorRole: SaleAccessRequester['role'] },
  ): Promise<PaymentMutationResult> {
    const amount = parsePaymentAmount(input.amount);
    // La normalización de TEXTO (trim/longitud) ya no decide si la
    // referencia es obligatoria (Ticket C, Bloque C3): eso depende del
    // PaymentMethod dinámico, resuelto dentro de PaymentEngine.register()
    // en la misma transacción — ver assertReferenceRequiredForMethod() ahí.
    const reference = normalizePaymentReference(input.reference);

    return this.prisma.$transaction(async (tx) => {
      const sale = await this.lockSale(tx, input.saleId);
      assertCanOperateSale(
        { id: input.actorUserId, role: input.actorRole },
        sale.sellerId,
        SALE_NOT_FOUND_FOR_PAYMENT,
      );
      if (sale.status === SaleStatus.CANCELLED) {
        throw new ConflictException('No se puede pagar una venta anulada');
      }

      const currentPaid = await this.paymentEngine.sumActiveForSale(
        tx,
        sale.id,
      );
      const currentBalance = sale.total.minus(currentPaid);
      if (amount.greaterThan(currentBalance)) {
        throw new ConflictException(
          'El monto supera el saldo pendiente de la venta',
        );
      }

      const payment = await this.paymentEngine.register(tx, {
        saleId: sale.id,
        saleNumber: sale.number,
        method: input.method,
        amount,
        reference,
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress ?? null,
      });

      const summary = await this.paymentEngine.recalculateSaleSummary(
        tx,
        sale.id,
        sale.total,
      );

      return {
        payment,
        sale: this.toSafeSalePaymentSummary(sale, summary),
      };
    });
  }

  /**
   * Anulación MANUAL de un pago existente. Nunca consulta Customer.status
   * (D6 aprobado): la única regla de elegibilidad de cancelación de pago es
   * la de Público general (D5), evaluada aquí ANTES de invocar al motor
   * para no dejar nunca un estado transitorio inválido.
   */
  async cancel(input: CancelPaymentInput): Promise<PaymentMutationResult> {
    const reason = normalizePaymentCancellationReason(input.reason);

    return this.prisma.$transaction(async (tx) => {
      const sale = await this.lockSale(tx, input.saleId);
      if (sale.status === SaleStatus.CANCELLED) {
        throw new ConflictException(
          'No se puede modificar el pago de una venta anulada',
        );
      }
      if (sale.customerIsGeneric) {
        throw new ConflictException(
          'No se puede anular un pago de una venta a Público general; anule la venta en su lugar',
        );
      }

      const payment = await this.paymentEngine.cancel(tx, {
        saleId: sale.id,
        saleNumber: sale.number,
        paymentId: input.paymentId,
        reason,
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress ?? null,
      });

      const summary = await this.paymentEngine.recalculateSaleSummary(
        tx,
        sale.id,
        sale.total,
      );

      return {
        payment,
        sale: this.toSafeSalePaymentSummary(sale, summary),
      };
    });
  }

  /**
   * Permisos por vendedor (P5): el alcance se decide por la venta del cobro
   * (Payment -> Sale.sellerId), NUNCA por Payment.createdByUserId (quien
   * registró el cobro). SELLER ve solo cobros de sus ventas, incluidos los
   * que registró un ADMIN; ADMIN/MANAGEMENT ven todos; WAREHOUSE/
   * desconocido, ninguno. El alcance se combina con AND con los filtros
   * (createdByUserId incluido) y el MISMO where alimenta findMany y count.
   */
  async list(
    query: ListPaymentsQuery,
    requester: SaleAccessRequester,
  ): Promise<PaginatedResult<SafePayment>> {
    const page =
      query.page !== undefined && query.page > 0
        ? Math.floor(query.page)
        : DEFAULT_PAGE;
    const limit = Math.min(
      query.limit !== undefined && query.limit > 0
        ? Math.floor(query.limit)
        : DEFAULT_LIMIT,
      MAX_LIMIT,
    );
    const skip = (page - 1) * limit;

    const saleScope = saleReadScopeWhere(requester);
    if (saleScope === null) {
      // Rol sin ningún acceso a Payment (WAREHOUSE u otro no contemplado):
      // página vacía sin tocar Prisma. Defensa en profundidad; el futuro
      // Bloque C igualmente rechaza esto con 403 en la capa HTTP.
      return { data: [], page, limit, total: 0, totalPages: 0 };
    }

    this.assertValidDateRangeQuery(query);

    const conditions: Prisma.PaymentWhereInput[] = [];
    if (query.method !== undefined) {
      // Filtra por el snapshot histórico (Ticket C, Bloque C3), nunca por
      // un join en vivo contra el PaymentMethod actual — normalizado igual
      // que en la creación (trim + mayúsculas) para que "cash"/"CASH"
      // encuentren los mismos resultados.
      conditions.push({
        paymentMethodCode: query.method.trim().toUpperCase(),
      });
    }
    if (query.status !== undefined) {
      conditions.push({ status: query.status });
    }
    if (query.createdByUserId !== undefined) {
      conditions.push({ createdByUserId: query.createdByUserId });
    }
    if (query.paidFrom !== undefined) {
      conditions.push({
        paidAt: { gte: startOfBusinessDayUtc(query.paidFrom) },
      });
    }
    if (query.paidTo !== undefined) {
      conditions.push({
        paidAt: { lt: endOfBusinessDayExclusiveUtc(query.paidTo) },
      });
    }

    const requested: Prisma.PaymentWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};
    // Sin restricción de propiedad ({}): filtros tal cual. Con alcance
    // (SELLER): AND por la venta asociada; ningún filtro lo amplía.
    const where: Prisma.PaymentWhereInput =
      Object.keys(saleScope).length === 0
        ? requested
        : { AND: [{ sale: saleScope }, requested] };

    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        select: PAYMENT_SAFE_SELECT,
        orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      data: rows.map(toSafePayment),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  // ==================================================================
  // Helpers privados
  // ==================================================================

  /**
   * Bloquea la venta directamente vía Prisma (sin SalesService/SalesModule,
   * mismo precedente que SalesService -> Quote, D17 de la Fase 6).
   */
  private async lockSale(
    tx: Prisma.TransactionClient,
    saleId: string,
  ): Promise<LockedSaleRow> {
    const rows = await tx.$queryRaw<LockedSaleRow[]>(Prisma.sql`
      SELECT
        id,
        number,
        status,
        seller_id AS "sellerId",
        total,
        customer_is_generic AS "customerIsGeneric"
      FROM sales
      WHERE id = ${saleId}::uuid
      FOR UPDATE
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(SALE_NOT_FOUND_FOR_PAYMENT);
    }
    return row;
  }

  private toSafeSalePaymentSummary(
    sale: LockedSaleRow,
    summary: {
      paymentStatus: SafeSalePaymentSummary['paymentStatus'];
      paidAmount: Prisma.Decimal;
      balanceDue: Prisma.Decimal;
    },
  ): SafeSalePaymentSummary {
    return {
      id: sale.id,
      number: sale.number,
      status: sale.status,
      total: sale.total.toFixed(2),
      paidAmount: summary.paidAmount.toFixed(2),
      balanceDue: summary.balanceDue.toFixed(2),
      paymentStatus: summary.paymentStatus,
    };
  }

  private assertValidDateRangeQuery(query: ListPaymentsQuery): void {
    if (query.paidFrom !== undefined && !isValidDateOnly(query.paidFrom)) {
      throw new BadRequestException(
        'paidFrom debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (query.paidTo !== undefined && !isValidDateOnly(query.paidTo)) {
      throw new BadRequestException(
        'paidTo debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (
      query.paidFrom !== undefined &&
      query.paidTo !== undefined &&
      query.paidFrom > query.paidTo
    ) {
      throw new BadRequestException('paidFrom no puede ser posterior a paidTo');
    }
  }
}
