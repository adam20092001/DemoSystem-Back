import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CategoryStatus,
  CustomerDocumentType,
  CustomerStatus,
  CustomerType,
  DocumentType,
  Prisma,
  ProductStatus,
  QuoteStatus,
  RoleName,
  UnitStatus,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  addCalendarDays,
  businessToday,
  fromPrismaDate,
  isValidDateOnly,
  toPrismaDate,
} from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { SettingsReader } from '../configuration/settings-reader.service';
import { PrismaService } from '../database/prisma.service';
import { DocumentSequenceService } from '../document-sequences/document-sequence.service';
import {
  QUOTE_DETAIL_SELECT,
  QUOTE_LIST_SELECT,
  toSafeQuote,
  toSafeQuoteListItem,
} from './mappers/quote.mapper';
import {
  assertAcceptable,
  assertDiscountWithinConfiguredLimit,
  assertDiscountWithinSubtotal,
  assertEditable,
  assertQuantityAllowedForUnit,
  assertRejectable,
  buildEffectiveQuoteStatusCondition,
  calculateLineTotal,
  calculateSubtotal,
  calculateTaxableBase,
  calculateTaxAmount,
  calculateTotal,
  effectiveStatus,
  parseDiscountAmount,
  parseQuantity,
} from './quote-calculator';
import { CreateQuoteInput } from './types/create-quote.input';
import { QuoteActionInput } from './types/quote-action.input';
import { ListQuotesQuery } from './types/list-quotes.query';
import { SafeQuote, SafeQuoteListItem } from './types/safe-quote';
import { UpdateQuoteInput } from './types/update-quote.input';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface EligibleCustomerSnapshot {
  id: string;
  customerType: CustomerType;
  documentType: CustomerDocumentType | null;
  documentNumber: string | null;
  name: string;
  address: string | null;
}

interface ValidatedItemLine {
  productId: string;
  productSku: string;
  productName: string;
  unitCode: string;
  unitName: string;
  unitAbbreviation: string;
  salePrice: Prisma.Decimal;
  quantity: Prisma.Decimal;
}

interface LockedQuoteRow {
  id: string;
  number: string;
  status: QuoteStatus;
  issueDate: Date;
  expirationDate: Date;
  subtotal: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
}

/**
 * Roles con acceso de lectura a Cotizaciones (defensa en profundidad; el
 * Bloque C decide el acceso HTTP real vía guards). WAREHOUSE no tiene
 * ningún acceso, igual que en Customers: `default` también falla cerrado
 * para que un rol futuro/desconocido nunca herede acceso por omisión.
 */
function hasQuoteReadAccess(role: RoleName): boolean {
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

function normalizeNotes(notes: string | null | undefined): string | null {
  if (notes === undefined || notes === null) {
    return null;
  }
  const trimmed = notes.trim();
  return trimmed.length > 0 ? trimmed : null;
}

@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly documentSequenceService: DocumentSequenceService,
    private readonly settingsReader: SettingsReader,
  ) {}

  async create(input: CreateQuoteInput): Promise<SafeQuote> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new BadRequestException(
        'La cotización debe tener al menos un ítem',
      );
    }
    this.assertNoDuplicateProductIds(input.items.map((item) => item.productId));

    if (
      input.expirationDate !== undefined &&
      !isValidDateOnly(input.expirationDate)
    ) {
      throw new BadRequestException(
        'La fecha de vencimiento debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }

    const discountAmount = parseDiscountAmount(input.discountAmount);
    const notes = normalizeNotes(input.notes);
    const parsedItems = input.items.map((item) => ({
      productId: item.productId,
      quantity: parseQuantity(item.quantity),
    }));

    const businessDate = businessToday();
    if (
      input.expirationDate !== undefined &&
      input.expirationDate < businessDate
    ) {
      throw new BadRequestException(
        'La fecha de vencimiento no puede ser anterior a la fecha de emisión',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Bloque 10, B: snapshot ÚNICO de configuración para esta operación.
      // quoteValidityDays solo se usa si expirationDate se omitió;
      // maxDiscountPercent SIEMPRE se necesita (incluso con expirationDate
      // explícito), así que la lectura nunca se condiciona a eso.
      const settings = await this.settingsReader.getCurrent(tx);

      // resolvedExpirationDate: explícito gana tal cual (§10 aprobado, sin
      // forzar quoteValidityDays sobre él); ausente -> issueDate (el MISMO
      // businessDate ya resuelto arriba) + quoteValidityDays días
      // calendario. Nunca una segunda businessToday() independiente.
      const resolvedExpirationDate =
        input.expirationDate ??
        addCalendarDays(businessDate, settings.quoteValidityDays);

      const customer = await this.loadAndValidateCustomer(tx, input.customerId);
      const lines = await this.loadAndValidateItems(tx, parsedItems);

      const lineTotals = lines.map((line) =>
        calculateLineTotal(line.quantity, line.salePrice),
      );
      const subtotal = calculateSubtotal(lineTotals);
      assertDiscountWithinSubtotal(discountAmount, subtotal);
      assertDiscountWithinConfiguredLimit(
        discountAmount,
        subtotal,
        settings.maxDiscountPercent,
      );
      // Fase 10, Bloque C: IGV a nivel de documento sobre la base imponible
      // (subtotal - descuento), nunca extraído de Product.salePrice ni
      // aplicado por ítem. taxEnabled=false -> 0.00 sin importar taxRate.
      const taxableBase = calculateTaxableBase(subtotal, discountAmount);
      const taxAmount = calculateTaxAmount(
        taxableBase,
        settings.taxEnabled,
        settings.taxRate,
      );
      const total = calculateTotal(subtotal, discountAmount, taxAmount);

      const number = await this.documentSequenceService.next(
        tx,
        DocumentType.QUOTE,
      );

      const created = await tx.quote.create({
        data: {
          number,
          status: QuoteStatus.PENDING,
          customerId: customer.id,
          customerType: customer.customerType,
          customerDocumentType: customer.documentType,
          customerDocumentNumber: customer.documentNumber,
          customerName: customer.name,
          customerAddress: customer.address,
          sellerId: input.actorUserId,
          issueDate: toPrismaDate(businessDate),
          expirationDate: toPrismaDate(resolvedExpirationDate),
          subtotal,
          discountAmount,
          taxAmount,
          total,
          // Fase 11, Bloque B: contexto de moneda/impuesto congelado con el
          // MISMO snapshot de settings ya leído arriba para taxAmount —
          // nunca una segunda lectura de SettingsReader.
          currencyCode: settings.currencyCode,
          taxEnabled: settings.taxEnabled,
          taxRate: settings.taxRate,
          notes,
          items: {
            create: lines.map((line, index) => ({
              productId: line.productId,
              productSku: line.productSku,
              productName: line.productName,
              unitCode: line.unitCode,
              unitName: line.unitName,
              unitAbbreviation: line.unitAbbreviation,
              quantity: line.quantity,
              unitPrice: line.salePrice,
              lineTotal: lineTotals[index],
            })),
          },
        },
        select: QUOTE_DETAIL_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'QUOTES',
        action: AuditAction.QUOTE_CREATED,
        entityType: 'Quote',
        entityId: created.id,
        description: `Cotización ${number} creada`,
        metadata: {
          quoteNumber: number,
          customerId: customer.id,
          itemCount: lines.length,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeQuote(created, businessDate);
    });
  }

  async update(input: UpdateQuoteInput): Promise<SafeQuote> {
    const hasHeaderChange =
      input.expirationDate !== undefined ||
      input.discountAmount !== undefined ||
      input.notes !== undefined;
    const hasItemsChange = input.items !== undefined;
    if (!hasHeaderChange && !hasItemsChange) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar',
      );
    }

    let parsedItems:
      { productId: string; quantity: Prisma.Decimal }[] | undefined;
    if (input.items !== undefined) {
      if (input.items.length === 0) {
        throw new BadRequestException(
          'La cotización debe conservar al menos un ítem',
        );
      }
      this.assertNoDuplicateProductIds(
        input.items.map((item) => item.productId),
      );
      parsedItems = input.items.map((item) => ({
        productId: item.productId,
        quantity: parseQuantity(item.quantity),
      }));
    }

    if (
      input.expirationDate !== undefined &&
      !isValidDateOnly(input.expirationDate)
    ) {
      throw new BadRequestException(
        'La fecha de vencimiento debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }

    const discountAmount =
      input.discountAmount !== undefined
        ? parseDiscountAmount(input.discountAmount)
        : undefined;

    const businessDate = businessToday();

    return this.prisma.$transaction(async (tx) => {
      const existing = await this.lockQuote(tx, input.quoteId);
      const effective = effectiveStatus(
        existing.status,
        existing.expirationDate,
        businessDate,
      );
      assertEditable(effective);

      const issueDateStr = fromPrismaDate(existing.issueDate);
      const effectiveExpirationDate =
        input.expirationDate ?? fromPrismaDate(existing.expirationDate);
      if (effectiveExpirationDate < issueDateStr) {
        throw new BadRequestException(
          'La fecha de vencimiento no puede ser anterior a la fecha de emisión',
        );
      }

      const updatedFields: string[] = [];
      const data: Prisma.QuoteUpdateInput = {};

      if (input.expirationDate !== undefined) {
        data.expirationDate = toPrismaDate(input.expirationDate);
        updatedFields.push('expirationDate');
      }
      if (input.notes !== undefined) {
        data.notes = normalizeNotes(input.notes);
        updatedFields.push('notes');
      }

      let subtotal: Prisma.Decimal;
      let itemCount: number;
      if (parsedItems !== undefined) {
        const lines = await this.loadAndValidateItems(tx, parsedItems);
        const lineTotals = lines.map((line) =>
          calculateLineTotal(line.quantity, line.salePrice),
        );
        subtotal = calculateSubtotal(lineTotals);
        itemCount = lines.length;

        await tx.quoteItem.deleteMany({ where: { quoteId: input.quoteId } });
        data.items = {
          create: lines.map((line, index) => ({
            productId: line.productId,
            productSku: line.productSku,
            productName: line.productName,
            unitCode: line.unitCode,
            unitName: line.unitName,
            unitAbbreviation: line.unitAbbreviation,
            quantity: line.quantity,
            unitPrice: line.salePrice,
            lineTotal: lineTotals[index],
          })),
        };
        updatedFields.push('items');
      } else {
        subtotal = existing.subtotal;
        itemCount = await tx.quoteItem.count({
          where: { quoteId: input.quoteId },
        });
      }

      const effectiveDiscount = discountAmount ?? existing.discountAmount;
      assertDiscountWithinSubtotal(effectiveDiscount, subtotal);

      // Bloque 10, B (§14/§15 del plan aprobado): el máximo configurado
      // solo se revalida cuando la actualización AFECTA realmente el par
      // comercial — items presentes (el subtotal puede cambiar, se evalúa
      // siempre que se reemplace el conjunto) o un discountAmount que
      // difiere del ya persistido (reenviar el mismo valor nunca cuenta
      // como cambio comercial nuevo). Una edición puramente no comercial
      // (p. ej. solo notes/expirationDate) nunca vuelve a evaluar el
      // descuento contra la configuración vigente, aunque esta se haya
      // endurecido después de que la cotización ya existía — cero
      // consultas a SettingsReader en ese caso.
      const affectsCommercialTotals =
        parsedItems !== undefined ||
        (discountAmount !== undefined &&
          !discountAmount.equals(existing.discountAmount));

      let taxAmount: Prisma.Decimal;
      if (affectsCommercialTotals) {
        // Fase 10, Bloque C (§20 del plan aprobado): una modificación
        // comercial siempre recalcula subtotal/descuento/impuesto/total con
        // la configuración VIGENTE — nunca preserva parcialmente el
        // impuesto histórico cuando el subtotal/descuento cambian. Una sola
        // lectura de SettingsReader para todo (máximo configurado + IGV).
        const settings = await this.settingsReader.getCurrent(tx);
        assertDiscountWithinConfiguredLimit(
          effectiveDiscount,
          subtotal,
          settings.maxDiscountPercent,
        );
        const taxableBase = calculateTaxableBase(subtotal, effectiveDiscount);
        taxAmount = calculateTaxAmount(
          taxableBase,
          settings.taxEnabled,
          settings.taxRate,
        );
        data.taxAmount = taxAmount;
        updatedFields.push('taxAmount');
        // Fase 11, Bloque B: el contexto de moneda/impuesto se actualiza EN
        // EL MISMO momento que taxAmount, con el mismo snapshot de
        // settings ya leído arriba — nunca por separado, nunca una
        // segunda lectura. Sería inconsistente recalcular taxAmount con la
        // configuración vigente pero dejar taxEnabled/taxRate desactualizados.
        data.currencyCode = settings.currencyCode;
        data.taxEnabled = settings.taxEnabled;
        data.taxRate = settings.taxRate;
        updatedFields.push('currencyCode', 'taxEnabled', 'taxRate');
      } else {
        // No comercial: el impuesto histórico se preserva EXACTO, sin
        // releer configuración ni recalcular — aunque taxEnabled/taxRate
        // hayan cambiado desde que la cotización se creó (§19 del plan
        // aprobado, previene deriva histórica retroactiva). Por el mismo
        // motivo, currencyCode/taxEnabled/taxRate tampoco se tocan aquí
        // (Prisma conserva el valor ya persistido al no incluirlos en `data`).
        taxAmount = existing.taxAmount;
      }

      const total = calculateTotal(subtotal, effectiveDiscount, taxAmount);

      if (discountAmount !== undefined) {
        data.discountAmount = discountAmount;
        updatedFields.push('discountAmount');
      }
      data.subtotal = subtotal;
      data.total = total;

      const updated = await tx.quote.update({
        where: { id: input.quoteId },
        data,
        select: QUOTE_DETAIL_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'QUOTES',
        action: AuditAction.QUOTE_UPDATED,
        entityType: 'Quote',
        entityId: input.quoteId,
        description: `Cotización ${existing.number} actualizada`,
        metadata: {
          quoteNumber: existing.number,
          updatedFields,
          itemCount,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeQuote(updated, businessDate);
    });
  }

  async accept(input: QuoteActionInput): Promise<SafeQuote> {
    return this.transitionStatus(
      input,
      QuoteStatus.ACCEPTED,
      AuditAction.QUOTE_ACCEPTED,
      assertAcceptable,
    );
  }

  async reject(input: QuoteActionInput): Promise<SafeQuote> {
    return this.transitionStatus(
      input,
      QuoteStatus.REJECTED,
      AuditAction.QUOTE_REJECTED,
      assertRejectable,
    );
  }

  async list(
    query: ListQuotesQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeQuoteListItem>> {
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

    if (!hasQuoteReadAccess(requesterRole)) {
      // Rol sin ningún acceso a Quote (WAREHOUSE u otro no contemplado):
      // página vacía sin tocar Prisma. Defensa en profundidad; el Bloque C
      // igualmente rechaza esto con 403 en la capa HTTP.
      return { data: [], page, limit, total: 0, totalPages: 0 };
    }

    this.assertValidDateRangeQuery(query);

    const businessDate = businessToday();
    const businessDateAsDate = toPrismaDate(businessDate);

    const conditions: Prisma.QuoteWhereInput[] = [];
    if (query.customerId !== undefined) {
      conditions.push({ customerId: query.customerId });
    }
    if (query.sellerId !== undefined) {
      conditions.push({ sellerId: query.sellerId });
    }
    if (query.issueDateFrom !== undefined) {
      conditions.push({
        issueDate: { gte: toPrismaDate(query.issueDateFrom) },
      });
    }
    if (query.issueDateTo !== undefined) {
      conditions.push({ issueDate: { lte: toPrismaDate(query.issueDateTo) } });
    }
    if (query.expirationDateFrom !== undefined) {
      conditions.push({
        expirationDate: { gte: toPrismaDate(query.expirationDateFrom) },
      });
    }
    if (query.expirationDateTo !== undefined) {
      conditions.push({
        expirationDate: { lte: toPrismaDate(query.expirationDateTo) },
      });
    }
    if (query.status !== undefined) {
      conditions.push(
        buildEffectiveQuoteStatusCondition(query.status, businessDateAsDate),
      );
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

    const where: Prisma.QuoteWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};

    const [rows, total] = await Promise.all([
      this.prisma.quote.findMany({
        where,
        select: QUOTE_LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.quote.count({ where }),
    ]);

    return {
      data: rows.map((row) => toSafeQuoteListItem(row, businessDate)),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findOne(quoteId: string, requesterRole: RoleName): Promise<SafeQuote> {
    if (!hasQuoteReadAccess(requesterRole)) {
      throw new NotFoundException('Cotización no encontrada');
    }
    const businessDate = businessToday();
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      select: QUOTE_DETAIL_SELECT,
    });
    if (quote === null) {
      throw new NotFoundException('Cotización no encontrada');
    }
    return toSafeQuote(quote, businessDate);
  }

  private async transitionStatus(
    input: QuoteActionInput,
    nextStatus: QuoteStatus,
    action: AuditAction,
    assertGuard: (effective: QuoteStatus) => void,
  ): Promise<SafeQuote> {
    const businessDate = businessToday();
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.lockQuote(tx, input.quoteId);
      const effective = effectiveStatus(
        existing.status,
        existing.expirationDate,
        businessDate,
      );
      assertGuard(effective);

      const updated = await tx.quote.update({
        where: { id: input.quoteId },
        data: { status: nextStatus },
        select: QUOTE_DETAIL_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'QUOTES',
        action,
        entityType: 'Quote',
        entityId: input.quoteId,
        description: `Cotización ${existing.number} cambia de estado`,
        metadata: {
          quoteNumber: existing.number,
          // effective === PENDING fue verificado por assertGuard, y solo
          // puede serlo si el estado almacenado también es PENDING (ver
          // effectiveStatus()): siempre 'PENDING' en este punto.
          previousStatus: existing.status,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeQuote(updated, businessDate);
    });
  }

  /**
   * Único lock de la fila Quote (SELECT ... FOR UPDATE) usado por update(),
   * accept() y reject(): evita que una edición y una transición de estado
   * concurrentes sobre la misma cotización se pisen entre sí. Sin bloquear
   * Customer ni Product (no se modifican en estas operaciones).
   */
  private async lockQuote(
    tx: Prisma.TransactionClient,
    quoteId: string,
  ): Promise<LockedQuoteRow> {
    const rows = await tx.$queryRaw<LockedQuoteRow[]>(Prisma.sql`
      SELECT
        id,
        number,
        status,
        issue_date       AS "issueDate",
        expiration_date  AS "expirationDate",
        subtotal,
        discount_amount  AS "discountAmount",
        tax_amount       AS "taxAmount"
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

  private assertNoDuplicateProductIds(productIds: string[]): void {
    const seen = new Set<string>();
    for (const productId of productIds) {
      if (seen.has(productId)) {
        throw new BadRequestException(
          'No se puede repetir el mismo producto en la cotización',
        );
      }
      seen.add(productId);
    }
  }

  private assertValidDateRangeQuery(query: ListQuotesQuery): void {
    const dateFields = [
      'issueDateFrom',
      'issueDateTo',
      'expirationDateFrom',
      'expirationDateTo',
    ] as const;
    for (const field of dateFields) {
      const value = query[field];
      if (value !== undefined && !isValidDateOnly(value)) {
        throw new BadRequestException(
          `${field} debe ser una fecha válida en formato YYYY-MM-DD`,
        );
      }
    }
    if (
      query.issueDateFrom !== undefined &&
      query.issueDateTo !== undefined &&
      query.issueDateFrom > query.issueDateTo
    ) {
      throw new BadRequestException(
        'issueDateFrom no puede ser posterior a issueDateTo',
      );
    }
    if (
      query.expirationDateFrom !== undefined &&
      query.expirationDateTo !== undefined &&
      query.expirationDateFrom > query.expirationDateTo
    ) {
      throw new BadRequestException(
        'expirationDateFrom no puede ser posterior a expirationDateTo',
      );
    }
  }

  private async loadAndValidateCustomer(
    tx: Prisma.TransactionClient,
    customerId: string,
  ): Promise<EligibleCustomerSnapshot> {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        isGeneric: true,
        status: true,
        customerType: true,
        documentType: true,
        documentNumber: true,
        name: true,
        address: true,
      },
    });
    if (customer === null) {
      throw new NotFoundException('El cliente no existe');
    }
    if (customer.isGeneric) {
      throw new ConflictException(
        'El cliente genérico "Público general" no puede usarse en cotizaciones',
      );
    }
    if (customer.status === CustomerStatus.INACTIVE) {
      throw new ConflictException(
        'El cliente debe estar activo o bloqueado para generar una cotización',
      );
    }
    if (customer.customerType === null) {
      // Estructuralmente inalcanzable (el CHECK customers_type_generic_
      // consistency de la Fase 4 garantiza que todo cliente no genérico
      // tiene customerType), pero se revalida en tiempo de ejecución sin
      // confiar en un invariante de otro módulo.
      throw new ConflictException(
        'El cliente no tiene un tipo válido para cotizar',
      );
    }

    return {
      id: customer.id,
      customerType: customer.customerType,
      documentType: customer.documentType,
      documentNumber: customer.documentNumber,
      name: customer.name,
      address: customer.address,
    };
  }

  /**
   * Carga y valida cada producto en el orden recibido (preserva el orden
   * para poder emparejar snapshots/lineTotal por índice). Nunca rechaza por
   * stock insuficiente: eso es solo informativo (ver quote.mapper.ts).
   */
  private async loadAndValidateItems(
    tx: Prisma.TransactionClient,
    items: { productId: string; quantity: Prisma.Decimal }[],
  ): Promise<ValidatedItemLine[]> {
    const lines: ValidatedItemLine[] = [];
    for (const item of items) {
      const product = await tx.product.findUnique({
        where: { id: item.productId },
        select: {
          id: true,
          sku: true,
          name: true,
          salePrice: true,
          status: true,
          category: { select: { status: true } },
          unit: {
            select: {
              code: true,
              name: true,
              abbreviation: true,
              status: true,
              allowDecimal: true,
            },
          },
        },
      });
      if (product === null) {
        throw new NotFoundException(`El producto ${item.productId} no existe`);
      }
      if (product.status !== ProductStatus.ACTIVE) {
        throw new ConflictException(
          `El producto ${product.sku} debe estar activo`,
        );
      }
      if (product.category.status !== CategoryStatus.ACTIVE) {
        throw new ConflictException(
          `La categoría del producto ${product.sku} debe estar activa`,
        );
      }
      if (product.unit.status !== UnitStatus.ACTIVE) {
        throw new ConflictException(
          `La unidad del producto ${product.sku} debe estar activa`,
        );
      }
      assertQuantityAllowedForUnit(item.quantity, product.unit.allowDecimal);

      lines.push({
        productId: product.id,
        productSku: product.sku,
        productName: product.name,
        unitCode: product.unit.code,
        unitName: product.unit.name,
        unitAbbreviation: product.unit.abbreviation,
        salePrice: product.salePrice,
        quantity: item.quantity,
      });
    }
    return lines;
  }
}
