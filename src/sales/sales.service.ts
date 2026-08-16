import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountingSourceType,
  CategoryStatus,
  CustomerDocumentType,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  DocumentType,
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
  ProductStatus,
  QuoteStatus,
  RoleName,
  SaleDeliveryStatus,
  SaleStatus,
  UnitStatus,
} from '@prisma/client';
import { AccountingEngine } from '../accounting/accounting.engine';
import { hasSaleEconomicActivity } from '../accounting/accounting-calculator';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService, PrismaExecutionClient } from '../audit/audit.service';
import {
  businessToday,
  endOfBusinessDayExclusiveUtc,
  isValidDateOnly,
  startOfBusinessDayUtc,
} from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import { DocumentSequenceService } from '../document-sequences/document-sequence.service';
import { StockMovementEngine } from '../inventory/stock-movement.engine';
import {
  PAYMENT_SAFE_SELECT,
  PaymentSafeRow,
} from '../payments/mappers/payment.mapper';
import {
  normalizePaymentReference,
  parsePaymentAmount,
} from '../payments/payment-calculator';
import { PaymentEngine } from '../payments/payment.engine';
import { InitialPaymentInput } from '../payments/types/payment.input';
import { effectiveStatus } from '../quotes/quote-calculator';
import {
  SALE_DETAIL_SELECT,
  SALE_INVENTORY_MOVEMENT_SELECT,
  SALE_LIST_SELECT,
  SaleInventoryMovementRow,
  toSafeSale,
  toSafeSaleListItem,
} from './mappers/sale.mapper';
import {
  SALE_TAX_AMOUNT,
  assertDiscountWithinSubtotal,
  assertQuantityAllowedForUnit,
  calculateLineTotal,
  calculateSubtotal,
  calculateTotal,
  deriveDeliveryStatus,
  deriveSalePaymentSummary,
  parseDiscountAmount,
  parseQuantity,
} from './sale-calculator';
import { ConvertQuoteToSaleInput } from './types/convert-quote-to-sale.input';
import { CreateSaleInput } from './types/create-sale.input';
import { ListSalesQuery } from './types/list-sales.query';
import { CancelSaleInput, SaleActionInput } from './types/sale-action.input';
import { SafeSale, SafeSaleListItem } from './types/safe-sale';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CANCELLATION_REASON_MAX_LENGTH = 200;

/** Referencia polimórfica que StockMovementEngine asocia a la venta (§57 del plan aprobado, sin FK). */
const SALE_REFERENCE_TYPE = 'Sale';

/**
 * Roles con acceso de lectura a Ventas (defensa en profundidad; el futuro
 * Bloque C decide el acceso HTTP real vía guards). WAREHOUSE no tiene
 * ningún acceso a Sale, igual que en Quotes/Customers. `default` también
 * falla cerrado: un rol futuro/desconocido nunca hereda visibilidad.
 */
function hasSaleReadAccess(role: RoleName): boolean {
  switch (role) {
    case RoleName.ADMIN:
    case RoleName.SELLER:
    case RoleName.MANAGEMENT:
      return true;
    case RoleName.WAREHOUSE:
    default:
      return false;
  }
}

interface LockedCustomerRow {
  id: string;
  isGeneric: boolean;
  status: CustomerStatus;
  customerStage: CustomerStage;
  customerType: CustomerType | null;
  documentType: CustomerDocumentType | null;
  documentNumber: string | null;
  name: string;
  address: string | null;
}

interface LockedProductRow {
  productId: string;
  sku: string;
  name: string;
  salePrice: Prisma.Decimal;
  isInventoryTracked: boolean;
  stockCurrent: Prisma.Decimal;
  productStatus: ProductStatus;
  categoryId: string;
  categoryStatus: CategoryStatus;
  unitId: string;
  unitCode: string;
  unitName: string;
  unitAbbreviation: string;
  unitStatus: UnitStatus;
  allowDecimal: boolean;
}

interface LockedQuoteRow {
  id: string;
  number: string;
  status: QuoteStatus;
  customerId: string;
  customerType: CustomerType;
  customerDocumentType: CustomerDocumentType | null;
  customerDocumentNumber: string | null;
  customerName: string;
  customerAddress: string | null;
  sellerId: string;
  issueDate: Date;
  expirationDate: Date;
  subtotal: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
}

interface LockedSaleRow {
  id: string;
  number: string;
  status: SaleStatus;
  deliveryStatus: SaleDeliveryStatus;
  subtotal: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
}

interface QuoteItemRow {
  productId: string;
  productSku: string;
  productName: string;
  unitCode: string;
  unitName: string;
  unitAbbreviation: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

/** Línea validada/lista para persistir. `isInventoryTracked` siempre viene del Product VIGENTE (nunca del snapshot). */
interface SaleItemLine {
  productId: string;
  productSku: string;
  productName: string;
  unitCode: string;
  unitName: string;
  unitAbbreviation: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  isInventoryTracked: boolean;
}

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly documentSequenceService: DocumentSequenceService,
    private readonly stockMovementEngine: StockMovementEngine,
    private readonly paymentEngine: PaymentEngine,
    private readonly accountingEngine: AccountingEngine,
  ) {}

  // ==================================================================
  // Venta directa
  // ==================================================================

  async createDirect(input: CreateSaleInput): Promise<SafeSale> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new BadRequestException('La venta debe tener al menos un ítem');
    }
    this.assertNoDuplicateProductIds(input.items.map((item) => item.productId));

    const discountAmount = parseDiscountAmount(input.discountAmount);
    const parsedItems = input.items.map((item) => ({
      productId: item.productId,
      quantity: parseQuantity(item.quantity),
    }));
    const initialPayment = this.parseInitialPayment(input.payment);

    return this.prisma.$transaction(async (tx) => {
      const customer = await this.lockCustomerForSale(tx, input.customerId);
      this.assertCustomerUsable(customer);

      const productIds = parsedItems.map((item) => item.productId);
      const lockedProducts = await this.lockProductsForSale(tx, productIds);
      for (const productId of productIds) {
        this.validateProductEligibility(
          this.requireLockedProduct(lockedProducts, productId),
        );
      }

      const lines: SaleItemLine[] = parsedItems.map((item) => {
        const locked = this.requireLockedProduct(
          lockedProducts,
          item.productId,
        );
        assertQuantityAllowedForUnit(item.quantity, locked.allowDecimal);
        this.assertSufficientStock(locked, item.quantity);
        return {
          productId: locked.productId,
          productSku: locked.sku,
          productName: locked.name,
          unitCode: locked.unitCode,
          unitName: locked.unitName,
          unitAbbreviation: locked.unitAbbreviation,
          quantity: item.quantity,
          unitPrice: locked.salePrice,
          lineTotal: calculateLineTotal(item.quantity, locked.salePrice),
          isInventoryTracked: locked.isInventoryTracked,
        };
      });

      const subtotal = calculateSubtotal(lines.map((line) => line.lineTotal));
      assertDiscountWithinSubtotal(discountAmount, subtotal);
      const total = calculateTotal(subtotal, discountAmount, SALE_TAX_AMOUNT);

      if (
        initialPayment !== undefined &&
        initialPayment.amount.greaterThan(total)
      ) {
        throw new ConflictException(
          'El monto del pago inicial no puede superar el total de la venta',
        );
      }

      const { paymentStatus, paidAmount, balanceDue } =
        deriveSalePaymentSummary(total, initialPayment?.amount);
      this.assertCustomerDebtRules(customer, balanceDue);
      const deliveryStatus = deriveDeliveryStatus(
        lines.some((line) => line.isInventoryTracked),
      );

      const number = await this.documentSequenceService.next(
        tx,
        DocumentType.SALE,
      );
      const confirmedAt = new Date();

      const created = await tx.sale.create({
        data: {
          number,
          status: SaleStatus.ACTIVE,
          paymentStatus,
          deliveryStatus,
          customerId: customer.id,
          customerIsGeneric: customer.isGeneric,
          customerType: customer.customerType,
          customerDocumentType: customer.documentType,
          customerDocumentNumber: customer.documentNumber,
          customerName: customer.name,
          customerAddress: customer.address,
          sellerId: input.actorUserId,
          subtotal,
          discountAmount,
          taxAmount: SALE_TAX_AMOUNT,
          total,
          paidAmount,
          balanceDue,
          confirmedAt,
          items: {
            create: lines.map((line) => ({
              productId: line.productId,
              productSku: line.productSku,
              productName: line.productName,
              unitCode: line.unitCode,
              unitName: line.unitName,
              unitAbbreviation: line.unitAbbreviation,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              lineTotal: line.lineTotal,
            })),
          },
        },
        select: SALE_DETAIL_SELECT,
      });

      // Reconocimiento contable de la venta (Fase 8, Bloque B), dentro de
      // la MISMA transacción: no-op documentado si la venta no tiene
      // actividad económica alguna (los cuatro montos en cero). Un pago
      // inicial, si existe, postea su propio asiento de cobro por separado
      // vía PaymentEngine.register más abajo — nunca combinados en un solo
      // asiento (plan final aprobado, §1/§33).
      await this.accountingEngine.postSaleRecognition(tx, {
        saleId: created.id,
        saleNumber: number,
        subtotal,
        discountAmount,
        taxAmount: SALE_TAX_AMOUNT,
        total,
        postedAt: confirmedAt,
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress ?? null,
      });

      const payments = await this.registerInitialPayment(
        tx,
        created.id,
        number,
        initialPayment,
        paidAmount,
        input.actorUserId,
        input.ipAddress ?? null,
      );

      await this.applyOutboundMovements(
        tx,
        created.id,
        number,
        lines,
        input.actorUserId,
        input.ipAddress ?? null,
      );

      await this.promoteProspectIfNeeded(
        tx,
        customer,
        input.actorUserId,
        input.ipAddress ?? null,
      );

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'SALES',
        action: AuditAction.SALE_CONFIRMED,
        entityType: 'Sale',
        entityId: created.id,
        description: `Venta ${number} confirmada`,
        metadata: {
          saleNumber: number,
          source: 'DIRECT',
          itemCount: lines.length,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      const movements = await this.fetchSaleInventoryMovements(tx, created.id);
      return toSafeSale(created, movements, payments);
    });
  }

  // ==================================================================
  // Venta desde cotización
  // ==================================================================

  async createFromQuote(input: ConvertQuoteToSaleInput): Promise<SafeSale> {
    const businessDate = businessToday();
    const initialPayment = this.parseInitialPayment(input.payment);

    return this.prisma.$transaction(async (tx) => {
      const quote = await this.lockQuoteForConversion(tx, input.quoteId);
      const effective = effectiveStatus(
        quote.status,
        quote.expirationDate,
        businessDate,
      );
      if (
        effective !== QuoteStatus.PENDING &&
        effective !== QuoteStatus.ACCEPTED
      ) {
        throw new ConflictException(
          'Solo una cotización pendiente o aceptada puede convertirse en venta',
        );
      }

      const existingSale = await tx.sale.findUnique({
        where: { quoteId: quote.id },
        select: { id: true },
      });
      if (existingSale !== null) {
        throw new ConflictException('La cotización ya generó una venta');
      }

      const quoteItems: QuoteItemRow[] = await tx.quoteItem.findMany({
        where: { quoteId: quote.id },
        select: {
          productId: true,
          productSku: true,
          productName: true,
          unitCode: true,
          unitName: true,
          unitAbbreviation: true,
          quantity: true,
          unitPrice: true,
          lineTotal: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      const customer = await this.lockCustomerForSale(tx, quote.customerId);
      this.assertCustomerUsable(customer);
      if (customer.isGeneric) {
        // Estado estructuralmente imposible: una cotización nunca se emite
        // contra el cliente genérico (Fase 5). Falla segura en vez de
        // producir una venta con historia contradictoria.
        throw new ConflictException(
          'El cliente de la cotización ya no es válido para generar una venta',
        );
      }

      const productIds = quoteItems.map((item) => item.productId);
      const lockedProducts = await this.lockProductsForSale(tx, productIds);
      for (const productId of productIds) {
        this.validateProductEligibility(
          this.requireLockedProduct(lockedProducts, productId),
        );
      }

      const lines: SaleItemLine[] = quoteItems.map((item) => {
        const locked = this.requireLockedProduct(
          lockedProducts,
          item.productId,
        );
        this.assertCurrentAllowDecimalForConversion(
          item.quantity,
          locked.allowDecimal,
          locked.sku,
        );
        this.assertSufficientStock(locked, item.quantity);
        return {
          productId: item.productId,
          productSku: item.productSku,
          productName: item.productName,
          unitCode: item.unitCode,
          unitName: item.unitName,
          unitAbbreviation: item.unitAbbreviation,
          // Cantidad/precio/línea copiados EXACTAMENTE del QuoteItem
          // histórico (D9): nunca se recalculan desde el catálogo vigente.
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          isInventoryTracked: locked.isInventoryTracked,
        };
      });

      // Montos comerciales copiados EXACTAMENTE del Quote (D9/D57): nunca
      // recalculados con el calculador de Ventas.
      const subtotal = quote.subtotal;
      const discountAmount = quote.discountAmount;
      const taxAmount = quote.taxAmount;
      const total = quote.total;

      if (
        initialPayment !== undefined &&
        initialPayment.amount.greaterThan(total)
      ) {
        throw new ConflictException(
          'El monto del pago inicial no puede superar el total de la venta',
        );
      }

      const { paymentStatus, paidAmount, balanceDue } =
        deriveSalePaymentSummary(total, initialPayment?.amount);
      this.assertCustomerDebtRules(customer, balanceDue);
      const deliveryStatus = deriveDeliveryStatus(
        lines.some((line) => line.isInventoryTracked),
      );

      const number = await this.documentSequenceService.next(
        tx,
        DocumentType.SALE,
      );
      const confirmedAt = new Date();

      const created = await tx.sale.create({
        data: {
          number,
          status: SaleStatus.ACTIVE,
          paymentStatus,
          deliveryStatus,
          customerId: customer.id,
          // D18 aprobado: la conversión de cotización nunca produce un Sale
          // con snapshot genérico (las cotizaciones no lo admiten).
          customerIsGeneric: false,
          customerType: quote.customerType,
          customerDocumentType: quote.customerDocumentType,
          customerDocumentNumber: quote.customerDocumentNumber,
          customerName: quote.customerName,
          customerAddress: quote.customerAddress,
          // D10: el vendedor es quien emitió la cotización, no quien ejecuta
          // la conversión (ese actor queda trazado en AuditLog.userId).
          sellerId: quote.sellerId,
          quoteId: quote.id,
          subtotal,
          discountAmount,
          taxAmount,
          total,
          paidAmount,
          balanceDue,
          confirmedAt,
          items: {
            create: lines.map((line) => ({
              productId: line.productId,
              productSku: line.productSku,
              productName: line.productName,
              unitCode: line.unitCode,
              unitName: line.unitName,
              unitAbbreviation: line.unitAbbreviation,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              lineTotal: line.lineTotal,
            })),
          },
        },
        select: SALE_DETAIL_SELECT,
      });

      // Reconocimiento contable de la venta (Fase 8, Bloque B), con los
      // montos EXACTOS copiados de la cotización (nunca recalculados) y el
      // mismo confirmedAt. Mismo criterio que createDirect: no-op si no hay
      // actividad económica; el pago inicial (si existe) postea su propio
      // asiento de cobro por separado.
      await this.accountingEngine.postSaleRecognition(tx, {
        saleId: created.id,
        saleNumber: number,
        subtotal,
        discountAmount,
        taxAmount,
        total,
        postedAt: confirmedAt,
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress ?? null,
      });

      const payments = await this.registerInitialPayment(
        tx,
        created.id,
        number,
        initialPayment,
        paidAmount,
        input.actorUserId,
        input.ipAddress ?? null,
      );

      await this.applyOutboundMovements(
        tx,
        created.id,
        number,
        lines,
        input.actorUserId,
        input.ipAddress ?? null,
      );

      await tx.quote.update({
        where: { id: quote.id },
        data: { status: QuoteStatus.CONVERTED },
      });

      await this.promoteProspectIfNeeded(
        tx,
        customer,
        input.actorUserId,
        input.ipAddress ?? null,
      );

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'SALES',
        action: AuditAction.SALE_CONFIRMED,
        entityType: 'Sale',
        entityId: created.id,
        description: `Venta ${number} confirmada desde cotización ${quote.number}`,
        metadata: {
          saleNumber: number,
          source: 'QUOTE',
          quoteId: quote.id,
          itemCount: lines.length,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'QUOTES',
        action: AuditAction.QUOTE_CONVERTED,
        entityType: 'Quote',
        entityId: quote.id,
        description: `Cotización ${quote.number} convertida en venta ${number}`,
        metadata: { quoteNumber: quote.number, saleNumber: number },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      const movements = await this.fetchSaleInventoryMovements(tx, created.id);
      return toSafeSale(created, movements, payments);
    });
  }

  // ==================================================================
  // Anulación
  // ==================================================================

  async cancel(input: CancelSaleInput): Promise<SafeSale> {
    const reason = this.normalizeCancellationReason(input.reason);

    return this.prisma.$transaction(async (tx) => {
      const sale = await this.lockSale(tx, input.saleId);
      if (sale.status === SaleStatus.CANCELLED) {
        throw new ConflictException('La venta ya está anulada');
      }

      // Instante ÚNICO de la operación de anulación completa (Fase 8,
      // Bloque B, plan final aprobado §30/§37/§38): se calcula una sola vez
      // aquí y se reutiliza para Sale.cancelledAt, cada
      // Payment.cancelledAt cancelado en cascada, el postedAt de cada
      // reversión contable de pago, y el postedAt de la reversión contable
      // de venta — nunca instantes independientes para el mismo evento.
      const cancelledAt = new Date();

      // Fuente de verdad de la reversa: los movimientos SALE/EXIT
      // ORIGINALES, nunca el estado vigente de isInventoryTracked (D22/§38
      // del plan aprobado). Ya vienen ordenados por productId ascendente:
      // como máximo un EXIT por producto por venta (unique(saleId,productId)).
      const originalMovements = await tx.inventoryMovement.findMany({
        where: {
          referenceType: SALE_REFERENCE_TYPE,
          referenceId: sale.id,
          origin: InventoryMovementOrigin.SALE,
          movementType: InventoryMovementType.EXIT,
        },
        select: { productId: true, quantity: true },
        orderBy: [{ productId: 'asc' }, { id: 'asc' }],
      });

      for (const movement of originalMovements) {
        await this.stockMovementEngine.apply(tx, {
          productId: movement.productId,
          quantity: movement.quantity,
          movementType: InventoryMovementType.ENTRY,
          origin: InventoryMovementOrigin.SALE_CANCELLATION,
          reason: `Reversa por anulación de venta ${sale.number}`,
          notes: null,
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress ?? null,
          referenceType: SALE_REFERENCE_TYPE,
          referenceId: sale.id,
        });
      }

      // Anula en cascada todos los pagos ACTIVE de la venta (Fase 7, Bloque
      // B) y revierte el asiento contable de cobro de cada uno (Fase 8,
      // Bloque B, dentro de PaymentEngine). El resumen de pago de Sale NO
      // se recalcula: queda congelado con sus valores previos a la
      // anulación (§44/§45 del plan aprobado); por eso NO se llama a
      // paymentEngine.recalculateSaleSummary() aquí.
      await this.paymentEngine.cancelAllActiveForSale(tx, {
        saleId: sale.id,
        saleNumber: sale.number,
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress ?? null,
        cancelledAt,
      });

      // Reversión del asiento de reconocimiento de venta (Fase 8, Bloque
      // B), SOLO si la venta tuvo actividad económica al confirmarse — una
      // venta all-zero (los cuatro montos en cero) nunca tuvo un ORIGINAL
      // que revertir (plan final aprobado, §12/§24/§35): intentar
      // revertirla sería un invariante roto, no un no-op silencioso. Una
      // venta con descuento total (subtotal>0, total=0) SÍ tuvo actividad y
      // por lo tanto SÍ se revierte (§41).
      if (
        hasSaleEconomicActivity(
          sale.subtotal,
          sale.discountAmount,
          sale.taxAmount,
          sale.total,
        )
      ) {
        await this.accountingEngine.reverseOriginalForSource(tx, {
          sourceType: AccountingSourceType.SALE,
          sourceId: sale.id,
          sourceNumber: sale.number,
          postedAt: cancelledAt,
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress ?? null,
        });
      }

      const updated = await tx.sale.update({
        where: { id: sale.id },
        data: {
          status: SaleStatus.CANCELLED,
          cancelledAt,
          cancellationReason: reason,
          cancelledByUserId: input.actorUserId,
        },
        select: SALE_DETAIL_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'SALES',
        action: AuditAction.SALE_CANCELLED,
        entityType: 'Sale',
        entityId: sale.id,
        description: `Venta ${sale.number} anulada`,
        metadata: {
          saleNumber: sale.number,
          previousStatus: SaleStatus.ACTIVE,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      const movements = await this.fetchSaleInventoryMovements(tx, sale.id);
      return toSafeSale(updated, movements);
    });
  }

  // ==================================================================
  // Entrega
  // ==================================================================

  async markDelivered(input: SaleActionInput): Promise<SafeSale> {
    return this.transitionDelivery(input, (current) => {
      if (
        current === SaleDeliveryStatus.PENDING ||
        current === SaleDeliveryStatus.OBSERVED
      ) {
        return SaleDeliveryStatus.DELIVERED;
      }
      throw new ConflictException(
        'No es posible marcar la venta como entregada en su estado actual',
      );
    });
  }

  async markObserved(input: SaleActionInput): Promise<SafeSale> {
    return this.transitionDelivery(input, (current) => {
      if (current === SaleDeliveryStatus.PENDING) {
        return SaleDeliveryStatus.OBSERVED;
      }
      throw new ConflictException(
        'No es posible marcar la venta como observada en su estado actual',
      );
    });
  }

  private async transitionDelivery(
    input: SaleActionInput,
    resolveNext: (current: SaleDeliveryStatus) => SaleDeliveryStatus,
  ): Promise<SafeSale> {
    return this.prisma.$transaction(async (tx) => {
      const sale = await this.lockSale(tx, input.saleId);
      if (sale.status === SaleStatus.CANCELLED) {
        throw new ConflictException(
          'No es posible cambiar el estado de entrega de una venta anulada',
        );
      }

      const previousDeliveryStatus = sale.deliveryStatus;
      const deliveryStatus = resolveNext(previousDeliveryStatus);

      const updated = await tx.sale.update({
        where: { id: sale.id },
        data: { deliveryStatus },
        select: SALE_DETAIL_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'SALES',
        action: AuditAction.SALE_DELIVERY_STATUS_CHANGED,
        entityType: 'Sale',
        entityId: sale.id,
        description: `Venta ${sale.number} cambia estado de entrega`,
        metadata: {
          saleNumber: sale.number,
          previousDeliveryStatus,
          deliveryStatus,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      const movements = await this.fetchSaleInventoryMovements(tx, sale.id);
      return toSafeSale(updated, movements);
    });
  }

  // ==================================================================
  // Lectura
  // ==================================================================

  async list(
    query: ListSalesQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeSaleListItem>> {
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

    if (!hasSaleReadAccess(requesterRole)) {
      // Rol sin ningún acceso a Sale (WAREHOUSE u otro no contemplado):
      // página vacía sin tocar Prisma. Defensa en profundidad; el futuro
      // Bloque C igualmente rechaza esto con 403 en la capa HTTP.
      return { data: [], page, limit, total: 0, totalPages: 0 };
    }

    this.assertValidDateRangeQuery(query);

    const conditions: Prisma.SaleWhereInput[] = [];
    if (query.status !== undefined) {
      conditions.push({ status: query.status });
    }
    if (query.paymentStatus !== undefined) {
      conditions.push({ paymentStatus: query.paymentStatus });
    }
    if (query.deliveryStatus !== undefined) {
      conditions.push({ deliveryStatus: query.deliveryStatus });
    }
    if (query.customerId !== undefined) {
      conditions.push({ customerId: query.customerId });
    }
    if (query.sellerId !== undefined) {
      conditions.push({ sellerId: query.sellerId });
    }
    if (query.quoteId !== undefined) {
      conditions.push({ quoteId: query.quoteId });
    }
    if (query.confirmedFrom !== undefined) {
      conditions.push({
        confirmedAt: { gte: startOfBusinessDayUtc(query.confirmedFrom) },
      });
    }
    if (query.confirmedTo !== undefined) {
      conditions.push({
        confirmedAt: { lt: endOfBusinessDayExclusiveUtc(query.confirmedTo) },
      });
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      conditions.push({
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { customerName: { contains: term, mode: 'insensitive' } },
          { customerDocumentNumber: { contains: term, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.SaleWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};

    const [rows, total] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        select: SALE_LIST_SELECT,
        orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.sale.count({ where }),
    ]);

    return {
      data: rows.map(toSafeSaleListItem),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findOne(saleId: string, requesterRole: RoleName): Promise<SafeSale> {
    if (!hasSaleReadAccess(requesterRole)) {
      throw new NotFoundException('Venta no encontrada');
    }
    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      select: SALE_DETAIL_SELECT,
    });
    if (sale === null) {
      throw new NotFoundException('Venta no encontrada');
    }
    const movements = await this.fetchSaleInventoryMovements(
      this.prisma,
      saleId,
    );
    return toSafeSale(sale, movements);
  }

  // ==================================================================
  // Helpers privados — locks
  // ==================================================================

  /**
   * Cliente no genérico: bloqueado con SELECT ... FOR UPDATE (nunca FOR
   * SHARE seguido de UPDATE). Público general se lee SIN el lock normal
   * (D6/D15): es una fila prácticamente inmutable (Fase 4) y bloquearla en
   * cada venta rápida la convertiría en un cuello de botella global.
   */
  private async lockCustomerForSale(
    tx: Prisma.TransactionClient,
    customerId: string,
  ): Promise<LockedCustomerRow> {
    const probe = await tx.$queryRaw<LockedCustomerRow[]>(Prisma.sql`
      SELECT
        id,
        is_generic      AS "isGeneric",
        status,
        customer_stage  AS "customerStage",
        customer_type   AS "customerType",
        document_type   AS "documentType",
        document_number AS "documentNumber",
        name,
        address
      FROM customers
      WHERE id = ${customerId}::uuid
    `);
    const probeRow = probe[0];
    if (probeRow === undefined) {
      throw new NotFoundException('El cliente no existe');
    }
    if (probeRow.isGeneric) {
      return probeRow;
    }

    const locked = await tx.$queryRaw<LockedCustomerRow[]>(Prisma.sql`
      SELECT
        id,
        is_generic      AS "isGeneric",
        status,
        customer_stage  AS "customerStage",
        customer_type   AS "customerType",
        document_type   AS "documentType",
        document_number AS "documentNumber",
        name,
        address
      FROM customers
      WHERE id = ${customerId}::uuid
      FOR UPDATE
    `);
    const lockedRow = locked[0];
    if (lockedRow === undefined) {
      throw new NotFoundException('El cliente no existe');
    }
    return lockedRow;
  }

  /**
   * Bloquea cada Product en orden ascendente determinista de productId
   * (nunca el orden de entrada del arreglo), reduciendo el riesgo de
   * deadlock entre ventas concurrentes con productos solapados. Una
   * consulta por producto: no se asume que `WHERE id IN (...)` garantice
   * el orden de adquisición del lock.
   */
  private async lockProductsForSale(
    tx: Prisma.TransactionClient,
    productIds: string[],
  ): Promise<Map<string, LockedProductRow>> {
    const uniqueSortedIds = Array.from(new Set(productIds)).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const result = new Map<string, LockedProductRow>();

    for (const productId of uniqueSortedIds) {
      const rows = await tx.$queryRaw<LockedProductRow[]>(Prisma.sql`
        SELECT
          p.id                   AS "productId",
          p.sku                  AS "sku",
          p.name                 AS "name",
          p.sale_price           AS "salePrice",
          p.is_inventory_tracked AS "isInventoryTracked",
          p.stock_current        AS "stockCurrent",
          p.status                AS "productStatus",
          c.id                    AS "categoryId",
          c.status                AS "categoryStatus",
          u.id                    AS "unitId",
          u.code                  AS "unitCode",
          u.name                  AS "unitName",
          u.abbreviation           AS "unitAbbreviation",
          u.status                AS "unitStatus",
          u.allow_decimal          AS "allowDecimal"
        FROM products p
        JOIN categories c ON c.id = p.category_id
        JOIN units u ON u.id = p.unit_id
        WHERE p.id = ${productId}::uuid
        FOR UPDATE OF p
        FOR SHARE OF c, u
      `);
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundException(`El producto ${productId} no existe`);
      }
      result.set(productId, row);
    }

    return result;
  }

  private requireLockedProduct(
    locked: Map<string, LockedProductRow>,
    productId: string,
  ): LockedProductRow {
    const row = locked.get(productId);
    if (row === undefined) {
      throw new NotFoundException(`El producto ${productId} no existe`);
    }
    return row;
  }

  private async lockQuoteForConversion(
    tx: Prisma.TransactionClient,
    quoteId: string,
  ): Promise<LockedQuoteRow> {
    const rows = await tx.$queryRaw<LockedQuoteRow[]>(Prisma.sql`
      SELECT
        id,
        number,
        status,
        customer_id               AS "customerId",
        customer_type             AS "customerType",
        customer_document_type    AS "customerDocumentType",
        customer_document_number  AS "customerDocumentNumber",
        customer_name             AS "customerName",
        customer_address          AS "customerAddress",
        seller_id                 AS "sellerId",
        issue_date                AS "issueDate",
        expiration_date           AS "expirationDate",
        subtotal,
        discount_amount           AS "discountAmount",
        tax_amount                AS "taxAmount",
        total
      FROM quotes
      WHERE id = ${quoteId}::uuid
      FOR UPDATE
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('La cotización no existe');
    }
    return row;
  }

  private async lockSale(
    tx: Prisma.TransactionClient,
    saleId: string,
  ): Promise<LockedSaleRow> {
    const rows = await tx.$queryRaw<LockedSaleRow[]>(Prisma.sql`
      SELECT
        id,
        number,
        status,
        delivery_status AS "deliveryStatus",
        subtotal,
        discount_amount AS "discountAmount",
        tax_amount AS "taxAmount",
        total
      FROM sales
      WHERE id = ${saleId}::uuid
      FOR UPDATE
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('La venta no existe');
    }
    return row;
  }

  // ==================================================================
  // Helpers privados — pago inicial (Fase 7, Bloque B)
  // ==================================================================

  /**
   * Parseo/normalización PURA, fuera de la transacción (mismo criterio que
   * discountAmount/items más arriba): si el pago inicial es malformado, la
   * venta falla con 400 sin llegar a abrir transacción. La validación de
   * "monto > total" es una regla de estado en vivo (necesita `total`
   * calculado) y se evalúa dentro de la transacción, no aquí.
   */
  private parseInitialPayment(payment: InitialPaymentInput | undefined):
    | {
        method: InitialPaymentInput['method'];
        amount: Prisma.Decimal;
        reference: string | null;
      }
    | undefined {
    if (payment === undefined) {
      return undefined;
    }
    const amount = parsePaymentAmount(payment.amount);
    const reference = normalizePaymentReference(
      payment.method,
      payment.reference,
    );
    return { method: payment.method, amount, reference };
  }

  /**
   * Registra el pago inicial (si existe) dentro de la MISMA transacción de
   * confirmación de la venta, después del INSERT de Sale (que ya lleva el
   * resumen de pago FINAL — D1 aprobado) y antes de los movimientos de
   * inventario. Reconcilia SUM(Payment ACTIVE) contra el paidAmount ya
   * calculado como defensa en profundidad (§39 del plan aprobado): con
   * exactamente un pago inicial posible, un desajuste solo puede significar
   * un error interno, nunca una entrada del cliente — 409, y toda la
   * transacción de la venta revierte. Retorna el arreglo (0 o 1 elemento)
   * listo para toSafeSale(): `created.payments` (de tx.sale.create) está
   * vacío por construcción en este punto, así que nunca se reutiliza aquí.
   */
  private async registerInitialPayment(
    tx: Prisma.TransactionClient,
    saleId: string,
    saleNumber: string,
    payment:
      | {
          method: InitialPaymentInput['method'];
          amount: Prisma.Decimal;
          reference: string | null;
        }
      | undefined,
    expectedPaidAmount: Prisma.Decimal,
    actorUserId: string,
    ipAddress: string | null,
  ): Promise<PaymentSafeRow[]> {
    if (payment === undefined) {
      return [];
    }

    await this.paymentEngine.register(tx, {
      saleId,
      saleNumber,
      method: payment.method,
      amount: payment.amount,
      reference: payment.reference,
      actorUserId,
      ipAddress,
    });

    const activeSum = await this.paymentEngine.sumActiveForSale(tx, saleId);
    if (!activeSum.equals(expectedPaidAmount)) {
      throw new ConflictException(
        'Inconsistencia interna en el resumen de pago al confirmar la venta',
      );
    }

    return tx.payment.findMany({
      where: { saleId },
      select: PAYMENT_SAFE_SELECT,
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    });
  }

  // ==================================================================
  // Helpers privados — validación
  // ==================================================================

  private assertNoDuplicateProductIds(productIds: string[]): void {
    const seen = new Set<string>();
    for (const productId of productIds) {
      if (seen.has(productId)) {
        throw new BadRequestException(
          'No se puede repetir el mismo producto en la venta',
        );
      }
      seen.add(productId);
    }
  }

  private assertCustomerUsable(customer: LockedCustomerRow): void {
    if (customer.status === CustomerStatus.INACTIVE) {
      throw new ConflictException(
        'El cliente debe estar activo o bloqueado para generar una venta',
      );
    }
  }

  /** Reglas de deuda (D4/D5/D19 del plan aprobado): sin Payment en la Fase 6, nunca se inventa dinero recibido. */
  private assertCustomerDebtRules(
    customer: LockedCustomerRow,
    balanceDue: Prisma.Decimal,
  ): void {
    if (customer.isGeneric && balanceDue.greaterThan(0)) {
      throw new ConflictException(
        'El cliente "Público general" no puede generar una venta con saldo pendiente',
      );
    }
    if (
      customer.status === CustomerStatus.BLOCKED &&
      balanceDue.greaterThan(0)
    ) {
      throw new ConflictException(
        'Un cliente bloqueado no puede generar una venta con saldo pendiente',
      );
    }
  }

  private validateProductEligibility(locked: LockedProductRow): void {
    if (locked.productStatus !== ProductStatus.ACTIVE) {
      throw new ConflictException(
        `El producto ${locked.sku} debe estar activo`,
      );
    }
    if (locked.categoryStatus !== CategoryStatus.ACTIVE) {
      throw new ConflictException(
        `La categoría del producto ${locked.sku} debe estar activa`,
      );
    }
    if (locked.unitStatus !== UnitStatus.ACTIVE) {
      throw new ConflictException(
        `La unidad del producto ${locked.sku} debe estar activa`,
      );
    }
  }

  private assertSufficientStock(
    locked: LockedProductRow,
    quantity: Prisma.Decimal,
  ): void {
    if (locked.isInventoryTracked && locked.stockCurrent.lessThan(quantity)) {
      throw new ConflictException(
        `Stock insuficiente para el producto ${locked.sku}`,
      );
    }
  }

  /**
   * Solo para conversión de cotización (§14/§28 del plan aprobado): a
   * diferencia de una venta directa (donde una cantidad incompatible con
   * allowDecimal es un payload malformado, 400), aquí la cantidad ya era
   * históricamente válida cuando se creó la cotización — el conflicto es
   * que el catálogo VIGENTE cambió después, así que es 409, no 400.
   */
  private assertCurrentAllowDecimalForConversion(
    quantity: Prisma.Decimal,
    allowDecimal: boolean,
    sku: string,
  ): void {
    if (!allowDecimal && !quantity.isInteger()) {
      throw new ConflictException(
        `La unidad vigente del producto ${sku} ya no admite cantidades fraccionarias como las de la cotización original`,
      );
    }
  }

  private normalizeCancellationReason(reason: string): string {
    if (typeof reason !== 'string') {
      throw new BadRequestException('El motivo de anulación es obligatorio');
    }
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(
        'El motivo de anulación no puede estar vacío',
      );
    }
    if (trimmed.length > CANCELLATION_REASON_MAX_LENGTH) {
      throw new BadRequestException(
        `El motivo de anulación no puede superar los ${CANCELLATION_REASON_MAX_LENGTH} caracteres`,
      );
    }
    return trimmed;
  }

  private assertValidDateRangeQuery(query: ListSalesQuery): void {
    if (
      query.confirmedFrom !== undefined &&
      !isValidDateOnly(query.confirmedFrom)
    ) {
      throw new BadRequestException(
        'confirmedFrom debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (
      query.confirmedTo !== undefined &&
      !isValidDateOnly(query.confirmedTo)
    ) {
      throw new BadRequestException(
        'confirmedTo debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (
      query.confirmedFrom !== undefined &&
      query.confirmedTo !== undefined &&
      query.confirmedFrom > query.confirmedTo
    ) {
      throw new BadRequestException(
        'confirmedFrom no puede ser posterior a confirmedTo',
      );
    }
  }

  // ==================================================================
  // Helpers privados — inventario / auditoría auxiliares
  // ==================================================================

  /**
   * Solo ítems con Product.isInventoryTracked VIGENTE=true, en orden
   * ascendente de productId (mismo orden que el lock, D24/D25). Cada
   * llamada relockea la misma fila ya tomada FOR UPDATE por
   * lockProductsForSale (reentrante dentro de la misma transacción, sin
   * costo adicional real).
   */
  private async applyOutboundMovements(
    tx: Prisma.TransactionClient,
    saleId: string,
    saleNumber: string,
    lines: SaleItemLine[],
    actorUserId: string,
    ipAddress: string | null,
  ): Promise<void> {
    const trackedLines = lines
      .filter((line) => line.isInventoryTracked)
      .sort((a, b) =>
        a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
      );

    for (const line of trackedLines) {
      await this.stockMovementEngine.apply(tx, {
        productId: line.productId,
        quantity: line.quantity,
        movementType: InventoryMovementType.EXIT,
        origin: InventoryMovementOrigin.SALE,
        reason: `Salida por venta ${saleNumber}`,
        notes: null,
        actorUserId,
        ipAddress,
        referenceType: SALE_REFERENCE_TYPE,
        referenceId: saleId,
      });
    }
  }

  /** Promueve PROSPECT->CUSTOMER dentro de la MISMA transacción (D6/D20). Nunca llama a CustomersService.convertToCustomer(). */
  private async promoteProspectIfNeeded(
    tx: Prisma.TransactionClient,
    customer: LockedCustomerRow,
    actorUserId: string,
    ipAddress: string | null,
  ): Promise<void> {
    if (
      customer.isGeneric ||
      customer.customerStage !== CustomerStage.PROSPECT
    ) {
      return;
    }

    await tx.customer.update({
      where: { id: customer.id },
      data: { customerStage: CustomerStage.CUSTOMER },
    });

    await this.auditService.record({
      userId: actorUserId,
      module: 'CUSTOMERS',
      action: AuditAction.CUSTOMER_STAGE_CHANGED,
      entityType: 'Customer',
      entityId: customer.id,
      description: `Cliente ${customer.id} convertido de prospecto a cliente`,
      metadata: {
        previousStage: CustomerStage.PROSPECT,
        customerStage: CustomerStage.CUSTOMER,
      },
      ipAddress,
      client: tx,
    });
  }

  /**
   * Segunda consulta independiente (§53 del plan aprobado): Sale no puede
   * `include` InventoryMovement porque la referencia es polimórfica
   * (referenceType/referenceId como texto, sin FK). Orden determinista
   * createdAt ASC, id ASC.
   */
  private async fetchSaleInventoryMovements(
    client: PrismaExecutionClient,
    saleId: string,
  ): Promise<SaleInventoryMovementRow[]> {
    return client.inventoryMovement.findMany({
      where: {
        referenceType: SALE_REFERENCE_TYPE,
        referenceId: saleId,
        origin: {
          in: [
            InventoryMovementOrigin.SALE,
            InventoryMovementOrigin.SALE_CANCELLATION,
          ],
        },
      },
      select: SALE_INVENTORY_MOVEMENT_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
}
