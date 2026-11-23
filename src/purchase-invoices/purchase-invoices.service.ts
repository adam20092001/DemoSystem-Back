import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountingSourceType,
  ImportOperationStatus,
  ImportShipmentStatus,
  Prisma,
  PurchaseAcquisitionKind,
  PurchaseInvoiceStatus,
  PurchaseLineTaxBasis,
  PurchaseLineTaxCategory,
  PurchasePurpose,
  RoleName,
  SupplierStatus,
} from '@prisma/client';
import { AccountingEngine } from '../accounting/accounting.engine';
import { buildPurchaseOriginalDescription } from '../accounting/accounting-calculator';
import { AuditAction } from '../audit/audit-action.enum';
import {
  BusinessConflictException,
  FieldBadRequestException,
} from '../common/errors/error-contract';
import { AuditService } from '../audit/audit.service';
import {
  businessToday,
  fromPrismaDate,
  isValidDateOnly,
  toPrismaDate,
} from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import { SettingsReader } from '../configuration/settings-reader.service';
import {
  PURCHASE_INVOICE_SAFE_SELECT,
  toSafePurchaseInvoice,
} from './mappers/purchase-invoice.mapper';
import {
  buildPurchaseRecognitionLines,
  calculatePurchaseInvoiceTotals,
  computePurchaseLineAmounts,
} from './purchase-invoice-calculator';
import {
  CancelPurchaseInvoiceInput,
  ConfirmPurchaseInvoiceInput,
} from './types/purchase-invoice-action.input';
import {
  CreatePurchaseInvoiceInput,
  CreatePurchaseInvoiceLineInput,
} from './types/create-purchase-invoice.input';
import { ListPurchaseInvoicesQuery } from './types/list-purchase-invoices.query';
import {
  BASE_UNIT_COST_MAX_DECIMALS,
  FOREIGN_UNIT_COST_MAX_DECIMALS,
  ResolvedCurrency,
  convertLineToBase,
  resolveDocumentCurrency,
  toBaseAmount,
} from './purchase-invoice-fx';
import { SafePurchaseInvoice } from './types/safe-purchase-invoice';
import { UpdatePurchaseInvoiceInput } from './types/update-purchase-invoice.input';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** ADMIN/MANAGEMENT/ACCOUNTANT/PURCHASING leen; SELLER/WAREHOUSE sin acceso a la factura completa (A5.2a §11; R1). */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
  RoleName.PURCHASING,
]);

/** R1: la autorización se separa por acción (antes un único conjunto de solo ADMIN). */
const CREATE_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.PURCHASING,
]);
const EDIT_DRAFT_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.PURCHASING,
]);
/** Excepción aprobada: MANAGEMENT confirma y anula, nunca crea/edita. */
const CONFIRM_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.PURCHASING,
]);
const CANCEL_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.PURCHASING,
]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar facturas de compra',
    );
  }
}

function assertCanCreate(requesterRole: RoleName): void {
  if (!CREATE_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para crear facturas de compra',
    );
  }
}

function assertCanEditDraft(requesterRole: RoleName): void {
  if (!EDIT_DRAFT_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para editar facturas de compra',
    );
  }
}

function assertCanConfirm(requesterRole: RoleName): void {
  if (!CONFIRM_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para confirmar facturas de compra',
    );
  }
}

function assertCanCancel(requesterRole: RoleName): void {
  if (!CANCEL_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para anular facturas de compra',
    );
  }
}

/** Máximo representable en DECIMAL(14,2). */
const MAX_BASE_AMOUNT = new Prisma.Decimal('999999999999.99');

interface LockedInvoiceRow {
  id: string;
  status: PurchaseInvoiceStatus;
  postedEntryId: string | null;
  documentType: string;
  documentSeries: string | null;
  documentNumber: string;
}

interface PreparedLine {
  productId: string | null;
  descriptionSnapshot: string;
  unitCodeSnapshot: string | null;
  unitNameSnapshot: string | null;
  acquisitionKind: PurchaseAcquisitionKind;
  purchasePurpose: PurchasePurpose;
  quantity: Prisma.Decimal;
  /** Moneda de la EMPRESA (contable). */
  unitCost: Prisma.Decimal;
  /** Moneda del DOCUMENTO. */
  unitCostOriginal: Prisma.Decimal;
  taxCategory: PurchaseLineTaxCategory;
  taxBasis: PurchaseLineTaxBasis | null;
  taxRateSnapshot: Prisma.Decimal | null;
  /** Importes en la moneda de la EMPRESA. */
  taxableBaseAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  creditableTaxAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  /** Importes en la moneda del DOCUMENTO. */
  taxableBaseAmountOriginal: Prisma.Decimal;
  taxAmountOriginal: Prisma.Decimal;
  creditableTaxAmountOriginal: Prisma.Decimal;
  lineTotalOriginal: Prisma.Decimal;
}

/**
 * Ciclo de vida de facturas de compra universales (Fase A5.2a):
 * crear/editar/listar/consultar (este servicio), confirmar y anular
 * (delegando el posteo/reversión REAL siempre a AccountingEngine, que
 * sigue siendo el único escritor de AccountingEntry/AccountingEntryLine —
 * este servicio NUNCA escribe esas tablas directamente). NUNCA modifica
 * inventario (StockMovementEngine/InventoryMovement/Product.stockCurrent
 * sin cambios aquí): esa es responsabilidad exclusiva de una futura Fase
 * A5.2b, todavía no implementada.
 */
@Injectable()
export class PurchaseInvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly accountingEngine: AccountingEngine,
    private readonly settingsReader: SettingsReader,
  ) {}

  // ==================================================================
  // Lectura
  // ==================================================================

  async listDrafts(
    query: ListPurchaseInvoicesQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafePurchaseInvoice>> {
    assertCanRead(requesterRole);

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

    const where: Prisma.PurchaseInvoiceWhereInput = {};
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.documentType !== undefined) {
      where.documentType = query.documentType;
    }
    if (query.supplierId !== undefined) {
      where.supplierId = query.supplierId;
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      where.OR = [
        { documentNumber: { contains: term, mode: 'insensitive' } },
        { documentSeries: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.purchaseInvoice.findMany({
        where,
        select: PURCHASE_INVOICE_SAFE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.purchaseInvoice.count({ where }),
    ]);

    return {
      data: rows.map(toSafePurchaseInvoice),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findOne(
    purchaseInvoiceId: string,
    requesterRole: RoleName,
  ): Promise<SafePurchaseInvoice> {
    assertCanRead(requesterRole);
    const row = await this.prisma.purchaseInvoice.findUnique({
      where: { id: purchaseInvoiceId },
      select: PURCHASE_INVOICE_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('Factura de compra no encontrada');
    }
    return toSafePurchaseInvoice(row);
  }

  // ==================================================================
  // Escritura — borrador (A5.2a)
  // ==================================================================

  async create(
    input: CreatePurchaseInvoiceInput,
  ): Promise<SafePurchaseInvoice> {
    assertCanCreate(input.requesterRole);

    const issueDate = this.normalizeDateOnly(input.issueDate, 'issueDate');
    const registrationDate = this.normalizeDateOnly(
      input.registrationDate ?? businessToday(),
      'registrationDate',
    );
    const accountingDate = this.normalizeDateOnly(
      input.accountingDate ?? businessToday(),
      'accountingDate',
    );
    const dueDate =
      input.dueDate !== undefined
        ? this.normalizeDateOnly(input.dueDate, 'dueDate')
        : null;
    const documentSeries = this.normalizeOptionalCode(input.documentSeries);
    const documentNumber = this.normalizeRequiredCode(
      input.documentNumber,
      'documentNumber',
    );

    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({
        where: { id: input.supplierId },
        select: { id: true, status: true },
      });
      if (supplier === null) {
        throw new BadRequestException('El proveedor indicado no existe');
      }
      if (supplier.status !== SupplierStatus.ACTIVE) {
        throw new ConflictException('El proveedor indicado no está activo');
      }

      // A0.2 (mismo criterio exacto que SalesService.createDirect()):
      // bloquea la fila singleton de configuración ANTES de leer
      // currencyCode/taxEnabled/taxRate, para que un cambio de moneda
      // concurrente nunca produzca un estado mixto.
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM company_settings WHERE singleton = true FOR UPDATE`,
      );
      const settings = await this.settingsReader.getCurrent(tx);

      // R4: moneda del documento, tasa (manual) y fecha de tasa. La moneda
      // contable es SIEMPRE la de la empresa vigente bajo el lock de arriba.
      const currency = resolveDocumentCurrency(
        {
          currencyCode: input.currencyCode,
          exchangeRate: input.exchangeRate,
          exchangeRateDate: input.exchangeRateDate,
        },
        settings.currencyCode,
        input.issueDate,
      );
      const lines = await this.prepareLines(
        tx,
        input.lines,
        settings.taxEnabled,
        settings.taxRate,
        currency,
      );
      const totals = this.totalsOf(lines);

      const created = await tx.purchaseInvoice.create({
        data: {
          supplierId: input.supplierId,
          documentType: input.documentType,
          documentSeries,
          documentNumber,
          issueDate,
          registrationDate,
          accountingDate,
          dueDate,
          paymentTermsDays: input.paymentTermsDays ?? null,
          currencyCode: currency.currencyCode,
          baseCurrencyCode: currency.baseCurrencyCode,
          exchangeRate: currency.exchangeRate,
          exchangeRateDate: toPrismaDate(currency.exchangeRateDate),
          subtotal: totals.base.subtotal,
          taxAmount: totals.base.taxAmount,
          totalAmount: totals.base.totalAmount,
          subtotalOriginal: totals.original.subtotal,
          taxAmountOriginal: totals.original.taxAmount,
          totalAmountOriginal: totals.original.totalAmount,
          createdByUserId: input.actorUserId,
          lines: {
            create: lines.map((line) => this.toLineCreateData(line)),
          },
        },
        select: PURCHASE_INVOICE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PURCHASE_INVOICES',
        action: AuditAction.PURCHASE_INVOICE_CREATED,
        entityType: 'PurchaseInvoice',
        entityId: created.id,
        description: `Factura de compra ${created.id} creada`,
        metadata: {
          supplierId: input.supplierId,
          documentType: input.documentType,
          currencyCode: currency.currencyCode,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafePurchaseInvoice(created);
    });
  }

  /**
   * PATCH con reemplazo COMPLETO de `lines` cuando se provee (mismo
   * criterio que ManualJournalDraft, A4.2). Bloqueado por fila: la misma
   * fila que confirm()/cancel() bloquean, así que edición y confirmación
   * de UNA MISMA factura nunca se intercalan de forma inconsistente.
   */
  async update(
    input: UpdatePurchaseInvoiceInput,
  ): Promise<SafePurchaseInvoice> {
    assertCanEditDraft(input.requesterRole);

    const hasAnyField =
      input.documentType !== undefined ||
      input.documentSeries !== undefined ||
      input.documentNumber !== undefined ||
      input.issueDate !== undefined ||
      input.registrationDate !== undefined ||
      input.accountingDate !== undefined ||
      input.dueDate !== undefined ||
      input.paymentTermsDays !== undefined ||
      input.currencyCode !== undefined ||
      input.exchangeRate !== undefined ||
      input.exchangeRateDate !== undefined ||
      input.lines !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockInvoice(tx, input.purchaseInvoiceId);
      if (locked.status !== PurchaseInvoiceStatus.DRAFT) {
        throw new ConflictException(
          'Solo se puede editar una factura de compra mientras está en estado DRAFT',
        );
      }

      const data: Prisma.PurchaseInvoiceUpdateInput = {};

      if (input.documentType !== undefined) {
        data.documentType = input.documentType;
      }
      if (input.documentSeries !== undefined) {
        data.documentSeries = this.normalizeOptionalCode(input.documentSeries);
      }
      if (input.documentNumber !== undefined) {
        data.documentNumber = this.normalizeRequiredCode(
          input.documentNumber,
          'documentNumber',
        );
      }
      if (input.issueDate !== undefined) {
        data.issueDate = this.normalizeDateOnly(input.issueDate, 'issueDate');
      }
      if (input.registrationDate !== undefined) {
        data.registrationDate = this.normalizeDateOnly(
          input.registrationDate,
          'registrationDate',
        );
      }
      if (input.accountingDate !== undefined) {
        data.accountingDate = this.normalizeDateOnly(
          input.accountingDate,
          'accountingDate',
        );
      }
      if (input.dueDate !== undefined) {
        data.dueDate =
          input.dueDate === null
            ? null
            : this.normalizeDateOnly(input.dueDate, 'dueDate');
      }
      if (input.paymentTermsDays !== undefined) {
        data.paymentTermsDays = input.paymentTermsDays;
      }

      // R4: moneda/tasa/fecha de tasa (solo en DRAFT; se congelan al confirmar).
      const currencyTouched =
        input.currencyCode !== undefined ||
        input.exchangeRate !== undefined ||
        input.exchangeRateDate !== undefined;
      let currency: ResolvedCurrency | null = null;
      if (currencyTouched || input.lines !== undefined) {
        const cur = await tx.purchaseInvoice.findUniqueOrThrow({
          where: { id: locked.id },
          select: {
            currencyCode: true,
            baseCurrencyCode: true,
            exchangeRate: true,
            exchangeRateDate: true,
            issueDate: true,
          },
        });
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM company_settings WHERE singleton = true FOR UPDATE`,
        );
        const settingsNow = await this.settingsReader.getCurrent(tx);
        const requestedCode =
          input.currencyCode !== undefined
            ? input.currencyCode.trim().toUpperCase()
            : cur.currencyCode;
        const currencyChanged = requestedCode !== cur.currencyCode;
        const keepsForeignRate =
          !currencyChanged && cur.currencyCode !== cur.baseCurrencyCode;
        currency = resolveDocumentCurrency(
          {
            currencyCode: requestedCode,
            exchangeRate:
              input.exchangeRate ??
              (keepsForeignRate ? cur.exchangeRate.toFixed() : undefined),
            exchangeRateDate:
              input.exchangeRateDate ??
              (currencyChanged ? undefined : fromPrismaDate(cur.exchangeRateDate)),
          },
          settingsNow.currencyCode,
          fromPrismaDate(cur.issueDate),
        );
        data.currencyCode = currency.currencyCode;
        data.baseCurrencyCode = currency.baseCurrencyCode;
        data.exchangeRate = currency.exchangeRate;
        data.exchangeRateDate = toPrismaDate(currency.exchangeRateDate);
      }

      if (input.lines === undefined && currency !== null) {
        // Solo cambió la moneda/tasa: se reconvierten a la moneda de la empresa
        // los importes ORIGINALES ya guardados (nunca se vuelven a tipear).
        const existingLines = await tx.purchaseInvoiceLine.findMany({
          where: { purchaseInvoiceId: locked.id },
          select: {
            id: true,
            unitCostOriginal: true,
            taxableBaseAmountOriginal: true,
            taxAmountOriginal: true,
            creditableTaxAmountOriginal: true,
            lineTotalOriginal: true,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        const rebased: {
          base: {
            taxableBaseAmount: Prisma.Decimal;
            taxAmount: Prisma.Decimal;
            lineTotal: Prisma.Decimal;
          };
          original: {
            taxableBaseAmount: Prisma.Decimal;
            taxAmount: Prisma.Decimal;
            lineTotal: Prisma.Decimal;
          };
        }[] = [];
        for (const line of existingLines) {
          const base = convertLineToBase(
            {
              taxableBaseAmount: line.taxableBaseAmountOriginal,
              taxAmount: line.taxAmountOriginal,
              creditableTaxAmount: line.creditableTaxAmountOriginal,
              lineTotal: line.lineTotalOriginal,
            },
            currency.exchangeRate,
          );
          this.assertBaseWithinRange(base.lineTotal);
          await tx.purchaseInvoiceLine.update({
            where: { id: line.id },
            data: {
              unitCost: toBaseAmount(line.unitCostOriginal, currency.exchangeRate),
              taxableBaseAmount: base.taxableBaseAmount,
              taxAmount: base.taxAmount,
              creditableTaxAmount: base.creditableTaxAmount,
              lineTotal: base.lineTotal,
            },
          });
          rebased.push({
            base,
            original: {
              taxableBaseAmount: line.taxableBaseAmountOriginal,
              taxAmount: line.taxAmountOriginal,
              lineTotal: line.lineTotalOriginal,
            },
          });
        }
        const totals = {
          base: calculatePurchaseInvoiceTotals(rebased.map((r) => r.base)),
          original: calculatePurchaseInvoiceTotals(
            rebased.map((r) => r.original),
          ),
        };
        data.subtotal = totals.base.subtotal;
        data.taxAmount = totals.base.taxAmount;
        data.totalAmount = totals.base.totalAmount;
        data.subtotalOriginal = totals.original.subtotal;
        data.taxAmountOriginal = totals.original.taxAmount;
        data.totalAmountOriginal = totals.original.totalAmount;
      }

      if (input.lines !== undefined && currency !== null) {
        const settings = await this.settingsReader.getCurrent(tx);
        const lines = await this.prepareLines(
          tx,
          input.lines,
          settings.taxEnabled,
          settings.taxRate,
          currency,
        );
        const totals = this.totalsOf(lines);
        data.subtotal = totals.base.subtotal;
        data.taxAmount = totals.base.taxAmount;
        data.totalAmount = totals.base.totalAmount;
        data.subtotalOriginal = totals.original.subtotal;
        data.taxAmountOriginal = totals.original.taxAmount;
        data.totalAmountOriginal = totals.original.totalAmount;

        await tx.purchaseInvoiceLine.deleteMany({
          where: { purchaseInvoiceId: locked.id },
        });
        await tx.purchaseInvoiceLine.createMany({
          data: lines.map((line) => ({
            purchaseInvoiceId: locked.id,
            ...this.toLineCreateData(line),
          })),
        });
      }

      if (Object.keys(data).length > 0) {
        await tx.purchaseInvoice.update({ where: { id: locked.id }, data });
      }

      const updated = await tx.purchaseInvoice.findUniqueOrThrow({
        where: { id: locked.id },
        select: PURCHASE_INVOICE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PURCHASE_INVOICES',
        action: AuditAction.PURCHASE_INVOICE_UPDATED,
        entityType: 'PurchaseInvoice',
        entityId: locked.id,
        description: `Factura de compra ${locked.id} actualizada`,
        metadata: { updatedFieldCount: Object.keys(data).length },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafePurchaseInvoice(updated);
    });
  }

  // ==================================================================
  // Confirmación (A5.2a)
  // ==================================================================

  async confirm(
    input: ConfirmPurchaseInvoiceInput,
  ): Promise<SafePurchaseInvoice> {
    assertCanConfirm(input.requesterRole);

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockInvoice(tx, input.purchaseInvoiceId);
      if (locked.status !== PurchaseInvoiceStatus.DRAFT) {
        throw new ConflictException(
          'Solo se puede confirmar una factura de compra en estado DRAFT',
        );
      }

      const invoice = await tx.purchaseInvoice.findUniqueOrThrow({
        where: { id: locked.id },
        include: { lines: true, supplier: { select: { status: true } } },
      });

      if (invoice.supplier.status !== SupplierStatus.ACTIVE) {
        throw new ConflictException(
          'No se puede confirmar: el proveedor de esta factura no está activo',
        );
      }

      // R4: la moneda contable (de la empresa) debe seguir siendo la del
      // momento de crear/editar el borrador. FOR SHARE: un cambio de moneda
      // concurrente (PATCH /configuration, que bloquea la fila FOR UPDATE)
      // espera a este commit y entonces encuentra el asiento (A0.2).
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM company_settings WHERE singleton = true FOR SHARE`,
      );
      const settingsAtConfirm = await this.settingsReader.getCurrent(tx);
      if (invoice.baseCurrencyCode !== settingsAtConfirm.currencyCode) {
        throw new BusinessConflictException({
          message:
            'No se puede confirmar: la moneda de la empresa cambió desde que se creó el borrador. Edite la factura para recalcular su moneda y tipo de cambio.',
          code: 'COMPANY_CURRENCY_CHANGED',
          field: 'currencyCode',
        });
      }
      if (invoice.lines.length === 0) {
        throw new BadRequestException(
          'La factura debe tener al menos una línea antes de confirmarse',
        );
      }

      // Dimensión C congelada (riesgo de mutabilidad identificado en la
      // revisión de A5.2): se calcula EXACTAMENTE AQUÍ, a partir de
      // Product.isInventoryTracked vigente en este instante, y nunca se
      // vuelve a derivar después — A5.2b (todavía no implementada)
      // consumirá este valor ya congelado, sin releer Product.
      const productIds = Array.from(
        new Set(
          invoice.lines
            .map((line) => line.productId)
            .filter((id): id is string => id !== null),
        ),
      );
      const products =
        productIds.length > 0
          ? await tx.product.findMany({
              where: { id: { in: productIds } },
              select: { id: true, isInventoryTracked: true },
            })
          : [];
      const trackedProductIds = new Set(
        products.filter((p) => p.isInventoryTracked).map((p) => p.id),
      );

      for (const line of invoice.lines) {
        const isReceiptEligible =
          line.acquisitionKind === PurchaseAcquisitionKind.GOOD &&
          line.productId !== null &&
          trackedProductIds.has(line.productId);
        await tx.purchaseInvoiceLine.update({
          where: { id: line.id },
          data: { isReceiptEligible },
        });
      }

      const recognitionLines = buildPurchaseRecognitionLines(
        invoice.lines.map((line) => ({
          purchasePurpose: line.purchasePurpose,
          taxableBaseAmount: line.taxableBaseAmount,
          taxAmount: line.taxAmount,
          creditableTaxAmount: line.creditableTaxAmount,
        })),
      );

      const documentLabel = this.formatDocumentLabel(
        invoice.documentType,
        invoice.documentSeries,
        invoice.documentNumber,
      );

      const posted = await this.accountingEngine.postPurchaseRecognition(tx, {
        purchaseInvoiceId: invoice.id,
        description: buildPurchaseOriginalDescription(documentLabel),
        accountingDateOnly: fromPrismaDate(invoice.accountingDate),
        lines: recognitionLines,
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress,
      });

      const updated = await tx.purchaseInvoice.update({
        where: { id: invoice.id },
        data: {
          status: PurchaseInvoiceStatus.CONFIRMED,
          confirmedAt: new Date(),
          postedEntryId: posted.id,
        },
        select: PURCHASE_INVOICE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PURCHASE_INVOICES',
        action: AuditAction.PURCHASE_INVOICE_CONFIRMED,
        entityType: 'PurchaseInvoice',
        entityId: invoice.id,
        description: `Factura de compra ${documentLabel} contabilizada`,
        metadata: { entryId: posted.id, journalNumber: posted.journalNumber },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafePurchaseInvoice(updated);
    });
  }

  // ==================================================================
  // Anulación (A5.2a)
  // ==================================================================

  /**
   * A5.2b agregó la guardia de recepciones ACTIVE; A5.3 agrega aquí la de
   * pagos ACTIVE (vía asignación a esta factura). Ninguna de las dos
   * cascada automáticamente: el usuario debe anular primero cada
   * recepción/pago.
   */
  async cancel(
    input: CancelPurchaseInvoiceInput,
  ): Promise<SafePurchaseInvoice> {
    assertCanCancel(input.requesterRole);

    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new BadRequestException('reason es obligatorio');
    }
    if (reason.length > 300) {
      throw new BadRequestException(
        'reason no puede superar los 300 caracteres',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockInvoice(tx, input.purchaseInvoiceId);
      if (locked.status !== PurchaseInvoiceStatus.CONFIRMED) {
        throw new ConflictException(
          'Solo se puede anular una factura de compra ya CONFIRMED',
        );
      }

      // Fase A5.2b: una factura con recepciones ACTIVE nunca se anula
      // automáticamente en cascada — el usuario debe anular primero cada
      // recepción. Verificado DESPUÉS del lock de fila de arriba (mismo
      // `purchase_invoices` FOR UPDATE que PurchaseReceiptsService.create()
      // toma antes de crear una recepción nueva): ambas rutas quedan
      // serializadas entre sí sin lock adicional ni riesgo de deadlock
      // (mismo orden de locks siempre — la factura primero).
      const activeReceiptsCount = await tx.purchaseReceipt.count({
        where: { purchaseInvoiceId: locked.id, status: 'ACTIVE' },
      });
      if (activeReceiptsCount > 0) {
        throw new ConflictException(
          'No se puede anular: existen recepciones activas para esta factura. Anule primero cada recepción.',
        );
      }

      // Fase A5.3: una factura con asignaciones de pago ACTIVE tampoco se
      // anula automáticamente en cascada — el usuario debe anular primero
      // cada pago. Mismo criterio de lock que arriba: ambas rutas quedan
      // serializadas entre sí sin lock adicional (la factura primero).
      const activePaymentAllocationsCount =
        await tx.supplierPaymentAllocation.count({
          where: {
            purchaseInvoiceId: locked.id,
            supplierPayment: { status: 'ACTIVE' },
          },
        });
      if (activePaymentAllocationsCount > 0) {
        throw new ConflictException(
          'No se puede anular: existen pagos activos asignados a esta factura. Anule primero cada pago.',
        );
      }

      // R4: una factura con una operación de importación vinculada que no esté
      // ANULADA (ni embarques activos que asignen sus líneas, incluidos los de
      // operaciones históricas) no se anula: primero se anula la importación o
      // el embarque. Orden de locks: factura (FOR UPDATE arriba) primero; la
      // creación de operaciones y embarques toma la factura FOR SHARE.
      const activeImportOperations = await tx.importOperation.count({
        where: {
          purchaseInvoiceId: locked.id,
          status: { not: ImportOperationStatus.CANCELLED },
        },
      });
      if (activeImportOperations > 0) {
        throw new BusinessConflictException({
          message:
            'No se puede anular: existe una operación de importación activa vinculada a esta factura. Anule primero la importación.',
          code: 'PURCHASE_INVOICE_HAS_ACTIVE_IMPORT',
        });
      }
      const activeShipmentAssignments = await tx.importShipmentLine.count({
        where: {
          purchaseInvoiceLine: { purchaseInvoiceId: locked.id },
          importShipment: {
            status: { not: ImportShipmentStatus.CANCELLED },
            importOperation: { status: { not: ImportOperationStatus.CANCELLED } },
          },
        },
      });
      if (activeShipmentAssignments > 0) {
        throw new BusinessConflictException({
          message:
            'No se puede anular: hay líneas de esta factura asignadas a embarques de importación activos. Anule primero el embarque.',
          code: 'PURCHASE_INVOICE_HAS_ACTIVE_SHIPMENT_LINES',
        });
      }

      const documentLabel = this.formatDocumentLabel(
        locked.documentType,
        locked.documentSeries,
        locked.documentNumber,
      );

      const reversal = await this.accountingEngine.reverseOriginalForSource(
        tx,
        {
          sourceType: AccountingSourceType.PURCHASE,
          sourceId: locked.id,
          sourceNumber: documentLabel,
          postedAt: new Date(),
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress,
        },
      );

      const updated = await tx.purchaseInvoice.update({
        where: { id: locked.id },
        data: {
          status: PurchaseInvoiceStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledByUserId: input.actorUserId,
          cancellationReason: reason,
        },
        select: PURCHASE_INVOICE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PURCHASE_INVOICES',
        action: AuditAction.PURCHASE_INVOICE_CANCELLED,
        entityType: 'PurchaseInvoice',
        entityId: locked.id,
        description: `Factura de compra ${documentLabel} anulada`,
        metadata: { reversalEntryId: reversal.id, reason },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafePurchaseInvoice(updated);
    });
  }

  // ==================================================================
  // Helpers privados
  // ==================================================================

  private async lockInvoice(
    tx: Prisma.TransactionClient,
    purchaseInvoiceId: string,
  ): Promise<LockedInvoiceRow> {
    const rows = await tx.$queryRaw<LockedInvoiceRow[]>(Prisma.sql`
      SELECT id, status, posted_entry_id AS "postedEntryId",
             document_type AS "documentType",
             document_series AS "documentSeries",
             document_number AS "documentNumber"
      FROM purchase_invoices
      WHERE id = ${purchaseInvoiceId}::uuid
      FOR UPDATE
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('Factura de compra no encontrada');
    }
    return row;
  }

  /**
   * Validación de EXISTENCIA pura para productId (A5.2a, mismo criterio
   * que ManualJournalEntriesService.assertAccountsExist(), A4.2): cualquier
   * producto real, activo o no — A5.2a nunca exige que esté ACTIVE (eso
   * es irrelevante mientras no se mueva inventario; A5.2b deberá validarlo
   * en el momento de recibir, no aquí).
   */
  private async prepareLines(
    tx: Prisma.TransactionClient,
    lines: CreatePurchaseInvoiceLineInput[],
    taxEnabled: boolean,
    companyTaxRate: Prisma.Decimal,
    currency: ResolvedCurrency,
  ): Promise<PreparedLine[]> {
    const productIds = Array.from(
      new Set(
        lines
          .map((line) => line.productId)
          .filter((id): id is string => id !== undefined),
      ),
    );
    const products =
      productIds.length > 0
        ? await tx.product.findMany({
            where: { id: { in: productIds } },
            select: {
              id: true,
              name: true,
              unit: { select: { code: true, name: true } },
            },
          })
        : [];
    const productsById = new Map(products.map((p) => [p.id, p]));
    for (const id of productIds) {
      if (!productsById.has(id)) {
        throw new BadRequestException(`El producto ${id} no existe`);
      }
    }

    return lines.map((line) => {
      const product =
        line.productId !== undefined
          ? productsById.get(line.productId)
          : undefined;

      let descriptionSnapshot: string;
      if (line.description !== undefined && line.description.trim() !== '') {
        descriptionSnapshot = line.description.trim();
      } else if (product !== undefined) {
        descriptionSnapshot = product.name;
      } else {
        throw new BadRequestException(
          'description es obligatoria cuando la línea no referencia un productId',
        );
      }

      const unitCodeSnapshot = product?.unit.code ?? null;
      const unitNameSnapshot =
        product?.unit.name ?? line.unitLabel?.trim() ?? null;

      const taxCategory = line.taxCategory;
      let taxBasis: CreatePurchaseInvoiceLineInput['taxBasis'] | undefined =
        line.taxBasis;
      let taxRate: Prisma.Decimal | null = null;

      if (taxCategory === PurchaseLineTaxCategory.TAXED) {
        if (!taxEnabled) {
          throw new BadRequestException(
            'No se puede declarar una línea con taxCategory=TAXED mientras el IGV de la empresa está desactivado',
          );
        }
        if (taxBasis === undefined) {
          throw new BadRequestException(
            'taxBasis es obligatorio cuando taxCategory=TAXED',
          );
        }
        taxRate = companyTaxRate;
      } else {
        taxBasis = undefined;
      }

      const quantity = this.parseDecimalInput(line.quantity, 'quantity');
      const unitCostOriginal = this.parseDecimalInput(line.unitCost, 'unitCost');
      const creditableTaxAmountInput =
        line.creditableTaxAmount !== undefined
          ? this.parseDecimalInput(
              line.creditableTaxAmount,
              'creditableTaxAmount',
            )
          : new Prisma.Decimal(0);

      // Importes en la MONEDA DEL DOCUMENTO (reglas de redondeo de siempre).
      const amounts = computePurchaseLineAmounts({
        quantity,
        unitCost: unitCostOriginal,
        taxCategory,
        taxBasis: taxBasis ?? null,
        taxRate,
        creditableTaxAmount: creditableTaxAmountInput,
        unitCostMaxDecimals: currency.isForeign
          ? FOREIGN_UNIT_COST_MAX_DECIMALS
          : BASE_UNIT_COST_MAX_DECIMALS,
      });
      // Cada COMPONENTE se convierte a la moneda de la empresa (HALF_UP, 2 dec.).
      const base = convertLineToBase(amounts, currency.exchangeRate);
      this.assertBaseWithinRange(base.lineTotal);

      return {
        productId: line.productId ?? null,
        descriptionSnapshot,
        unitCodeSnapshot,
        unitNameSnapshot,
        acquisitionKind: line.acquisitionKind,
        purchasePurpose: line.purchasePurpose,
        quantity,
        unitCost: toBaseAmount(unitCostOriginal, currency.exchangeRate),
        unitCostOriginal,
        taxCategory,
        taxBasis: taxBasis ?? null,
        taxRateSnapshot: taxRate,
        taxableBaseAmount: base.taxableBaseAmount,
        taxAmount: base.taxAmount,
        creditableTaxAmount: base.creditableTaxAmount,
        lineTotal: base.lineTotal,
        taxableBaseAmountOriginal: amounts.taxableBaseAmount,
        taxAmountOriginal: amounts.taxAmount,
        creditableTaxAmountOriginal: amounts.creditableTaxAmount,
        lineTotalOriginal: amounts.lineTotal,
      };
    });
  }

  private toLineCreateData(
    line: PreparedLine,
  ): Prisma.PurchaseInvoiceLineCreateManyPurchaseInvoiceInput {
    return {
      productId: line.productId,
      descriptionSnapshot: line.descriptionSnapshot,
      unitCodeSnapshot: line.unitCodeSnapshot,
      unitNameSnapshot: line.unitNameSnapshot,
      acquisitionKind: line.acquisitionKind,
      purchasePurpose: line.purchasePurpose,
      quantity: line.quantity,
      unitCost: line.unitCost,
      unitCostOriginal: line.unitCostOriginal,
      taxCategory: line.taxCategory,
      taxBasis: line.taxBasis,
      taxRateSnapshot: line.taxRateSnapshot,
      taxableBaseAmount: line.taxableBaseAmount,
      taxAmount: line.taxAmount,
      creditableTaxAmount: line.creditableTaxAmount,
      lineTotal: line.lineTotal,
      taxableBaseAmountOriginal: line.taxableBaseAmountOriginal,
      taxAmountOriginal: line.taxAmountOriginal,
      creditableTaxAmountOriginal: line.creditableTaxAmountOriginal,
      lineTotalOriginal: line.lineTotalOriginal,
    };
  }

  /**
   * Totales de cabecera: SIEMPRE la suma de las líneas ya convertidas (moneda de
   * la empresa) y de las líneas originales (moneda del documento); nunca se
   * convierte el total del documento (evita diferencias de céntimos con el
   * asiento).
   */
  private totalsOf(lines: PreparedLine[]): {
    base: ReturnType<typeof calculatePurchaseInvoiceTotals>;
    original: ReturnType<typeof calculatePurchaseInvoiceTotals>;
  } {
    return {
      base: calculatePurchaseInvoiceTotals(lines),
      original: calculatePurchaseInvoiceTotals(
        lines.map((line) => ({
          taxableBaseAmount: line.taxableBaseAmountOriginal,
          taxAmount: line.taxAmountOriginal,
          lineTotal: line.lineTotalOriginal,
        })),
      ),
    };
  }

  /** El equivalente en moneda de la empresa debe caber en DECIMAL(14,2). */
  private assertBaseWithinRange(baseLineTotal: Prisma.Decimal): void {
    if (baseLineTotal.greaterThan(MAX_BASE_AMOUNT)) {
      throw new FieldBadRequestException({
        message:
          'El equivalente en la moneda de la empresa excede la capacidad representable; revise el tipo de cambio',
        code: 'BASE_AMOUNT_OUT_OF_RANGE',
        field: 'exchangeRate',
      });
    }
  }

  private parseDecimalInput(raw: string, fieldName: string): Prisma.Decimal {
    try {
      return new Prisma.Decimal(raw);
    } catch {
      throw new BadRequestException(`${fieldName} no es un decimal válido`);
    }
  }

  private normalizeDateOnly(raw: string, fieldName: string): Date {
    if (!isValidDateOnly(raw)) {
      throw new BadRequestException(
        `${fieldName} debe ser una fecha real en formato YYYY-MM-DD`,
      );
    }
    return toPrismaDate(raw);
  }

  private normalizeRequiredCode(raw: string, fieldName: string): string {
    const trimmed = raw.trim().toUpperCase();
    if (trimmed.length === 0) {
      throw new BadRequestException(`${fieldName} no puede estar vacío`);
    }
    return trimmed;
  }

  private normalizeOptionalCode(raw: string | null | undefined): string | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    const trimmed = raw.trim().toUpperCase();
    return trimmed.length > 0 ? trimmed : null;
  }

  private formatDocumentLabel(
    documentType: string,
    documentSeries: string | null,
    documentNumber: string,
  ): string {
    const number =
      documentSeries !== null
        ? `${documentSeries}-${documentNumber}`
        : documentNumber;
    return `${documentType} ${number}`;
  }
}
