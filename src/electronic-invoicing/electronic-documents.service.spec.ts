import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CustomerDocumentType,
  ElectronicDocumentStatus,
  FiscalDocumentType,
  Prisma,
  SaleStatus,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ElectronicDocumentsService } from './electronic-documents.service';
import { FiscalSeriesService } from './fiscal-series.service';
import {
  RetryableProviderSubmissionError,
  UnknownProviderSubmissionOutcomeError,
} from './providers/electronic-invoicing-provider-errors';
import type { ElectronicInvoicingProvider } from './providers/electronic-invoicing-provider.interface';
import { IssueElectronicDocumentCommand } from './types/issue-electronic-document.command';

const SALE_ID = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222';
const FISCAL_SERIES_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const SALE_NUMBER = 'NV-000001';

function makeSaleRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SALE_ID,
    number: SALE_NUMBER,
    status: SaleStatus.ACTIVE,
    customerIsGeneric: false,
    customerDocumentType: CustomerDocumentType.RUC,
    customerDocumentNumber: '20123456789',
    customerName: 'Distribuidora Fiscal SAC',
    customerAddress: 'Av. Siempre Viva 123',
    subtotal: new Prisma.Decimal('100.00'),
    discountAmount: new Prisma.Decimal('0.00'),
    taxAmount: new Prisma.Decimal('18.00'),
    total: new Prisma.Decimal('118.00'),
    currencyCode: 'PEN',
    items: [makeSaleItemRow()],
    ...overrides,
  };
}

function makeSaleItemRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    productSku: 'SKU-001',
    productName: 'Producto Fiscal',
    unitCode: 'UND',
    unitName: 'Unidad',
    unitAbbreviation: 'und',
    quantity: new Prisma.Decimal('2.000'),
    unitPrice: new Prisma.Decimal('50.00'),
    lineTotal: new Prisma.Decimal('100.00'),
    ...overrides,
  };
}

function makeCompanySettingsRow(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    businessName: 'Empresa Demo SAC',
    taxId: '20100000001',
    address: 'Av. Principal 100',
    ...overrides,
  };
}

function makeCommand(
  overrides: Partial<IssueElectronicDocumentCommand> = {},
): IssueElectronicDocumentCommand {
  return {
    saleId: SALE_ID,
    documentType: FiscalDocumentType.FACTURA,
    series: 'F001',
    actorUserId: ACTOR_ID,
    ipAddress: null,
    ...overrides,
  };
}

/** Fila completa devuelta por ELECTRONIC_DOCUMENT_SAFE_SELECT (transitionToSubmitted/persistProviderOutcome). */
function makeElectronicDocumentSafeRow(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id: DOCUMENT_ID,
    saleId: SALE_ID,
    fiscalSeriesId: FISCAL_SERIES_ID,
    documentType: FiscalDocumentType.FACTURA,
    series: 'F001',
    number: 1,
    status: ElectronicDocumentStatus.SUBMITTED,
    providerCode: 'MOCK',
    currencyCode: 'PEN',
    issuerTaxId: '20100000001',
    issuerBusinessName: 'Empresa Demo SAC',
    issuerAddress: 'Av. Principal 100',
    customerDocumentType: CustomerDocumentType.RUC,
    customerDocumentNumber: '20123456789',
    customerName: 'Distribuidora Fiscal SAC',
    customerAddress: 'Av. Siempre Viva 123',
    subtotal: new Prisma.Decimal('100.00'),
    discountAmount: new Prisma.Decimal('0.00'),
    taxableBase: new Prisma.Decimal('100.00'),
    taxAmount: new Prisma.Decimal('18.00'),
    total: new Prisma.Decimal('118.00'),
    providerExternalId: null,
    providerStatus: null,
    providerMessage: null,
    submissionCount: 1,
    issuedAt: new Date('2026-03-15T12:00:00.000Z'),
    lastSubmittedAt: new Date('2026-03-15T12:00:01.000Z'),
    acceptedAt: null,
    rejectedAt: null,
    createdAt: new Date('2026-03-15T12:00:00.000Z'),
    updatedAt: new Date('2026-03-15T12:00:01.000Z'),
    items: [
      {
        id: 'item-1',
        lineNumber: 1,
        productSku: 'SKU-001',
        description: 'Producto Fiscal',
        unitCode: 'UND',
        unitName: 'Unidad',
        unitAbbreviation: 'und',
        quantity: new Prisma.Decimal('2.000'),
        unitPrice: new Prisma.Decimal('50.00'),
        lineTotal: new Prisma.Decimal('100.00'),
      },
    ],
    ...overrides,
  };
}

function createTxMock() {
  return {
    $queryRaw: jest.fn<Promise<unknown[]>, [Prisma.Sql]>(),
    sale: {
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      findUniqueOrThrow: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    electronicDocument: {
      findFirst: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      findUniqueOrThrow: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      update: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    companySettings: {
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
}

function createFiscalSeriesServiceMock() {
  return {
    allocateNext: jest.fn<
      Promise<{ fiscalSeriesId: string; number: number }>,
      [unknown, FiscalDocumentType, string]
    >(),
  };
}

function createProviderMock() {
  return {
    code: 'MOCK',
    submit: jest.fn<Promise<unknown>, [unknown]>(),
  };
}

describe('ElectronicDocumentsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let tx: ReturnType<typeof createTxMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let fiscalSeriesService: ReturnType<typeof createFiscalSeriesServiceMock>;
  let provider: ReturnType<typeof createProviderMock>;
  let service: ElectronicDocumentsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    tx = prisma.tx;
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    fiscalSeriesService = createFiscalSeriesServiceMock();
    fiscalSeriesService.allocateNext.mockResolvedValue({
      fiscalSeriesId: FISCAL_SERIES_ID,
      number: 1,
    });
    provider = createProviderMock();
    provider.submit.mockResolvedValue({
      outcome: 'ACCEPTED',
      externalId: `MOCK-${DOCUMENT_ID}`,
      providerStatus: 'ACCEPTED',
      providerMessage:
        'Documento aceptado por el proveedor de demostración (MOCK).',
    });

    service = new ElectronicDocumentsService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
      fiscalSeriesService as unknown as FiscalSeriesService,
      provider as unknown as ElectronicInvoicingProvider,
    );

    // Camino feliz por defecto: FACTURA con cliente RUC válido, emisor
    // válido, sin documento primario previo, creación + transición +
    // proveedor ACCEPTED.
    tx.sale.findUnique.mockResolvedValue(makeSaleRow());
    tx.electronicDocument.findFirst.mockResolvedValue(null);
    tx.companySettings.findUnique.mockResolvedValue(makeCompanySettingsRow());
    tx.electronicDocument.create.mockResolvedValue({ id: DOCUMENT_ID });
    tx.$queryRaw.mockResolvedValue([{ id: DOCUMENT_ID }]);
    tx.electronicDocument.findUniqueOrThrow.mockResolvedValue(
      makeElectronicDocumentSafeRow({
        status: ElectronicDocumentStatus.SUBMITTED,
      }),
    );
    tx.sale.findUniqueOrThrow.mockResolvedValue({ number: SALE_NUMBER });
    tx.electronicDocument.update.mockResolvedValue(
      makeElectronicDocumentSafeRow({
        status: ElectronicDocumentStatus.ACCEPTED,
        providerExternalId: `MOCK-${DOCUMENT_ID}`,
        providerStatus: 'ACCEPTED',
        providerMessage:
          'Documento aceptado por el proveedor de demostración (MOCK).',
        acceptedAt: new Date('2026-03-15T12:00:02.000Z'),
      }),
    );
  });

  // ====================================================================
  // issue() — validación de venta (§6)
  // ====================================================================
  describe('issue — validación de venta', () => {
    it('venta inexistente -> NotFoundException, sin llamar al proveedor', async () => {
      tx.sale.findUnique.mockResolvedValue(null);

      await expect(service.issue(makeCommand())).rejects.toThrow(
        NotFoundException,
      );
      expect(provider.submit).not.toHaveBeenCalled();
      expect(fiscalSeriesService.allocateNext).not.toHaveBeenCalled();
    });

    it('venta CANCELLED -> ConflictException, sin asignar número fiscal', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ status: SaleStatus.CANCELLED }),
      );

      await expect(service.issue(makeCommand())).rejects.toThrow(
        ConflictException,
      );
      expect(fiscalSeriesService.allocateNext).not.toHaveBeenCalled();
    });

    it('no exige PAID ni saldo cero: una venta ACTIVE con deuda es válida', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ status: SaleStatus.ACTIVE }),
      );

      await expect(service.issue(makeCommand())).resolves.toBeDefined();
    });
  });

  // ====================================================================
  // issue() — documento primario existente (§7)
  // ====================================================================
  describe('issue — documento fiscal primario existente', () => {
    it('ya existe FACTURA/BOLETA para la venta -> ConflictException, sin asignar número', async () => {
      tx.electronicDocument.findFirst.mockResolvedValue({ id: 'existing-doc' });

      await expect(service.issue(makeCommand())).rejects.toThrow(
        ConflictException,
      );
      expect(fiscalSeriesService.allocateNext).not.toHaveBeenCalled();
      expect(tx.electronicDocument.create).not.toHaveBeenCalled();
    });

    it('traduce una violación P2002 de la transacción de creación en ConflictException limpio', async () => {
      prisma.$transaction.mockImplementationOnce(() => {
        throw new Prisma.PrismaClientKnownRequestError(
          'conflicto de unicidad',
          {
            code: 'P2002',
            clientVersion: '6.0.0',
          },
        );
      });

      await expect(service.issue(makeCommand())).rejects.toThrow(
        ConflictException,
      );
    });

    it('propaga sin envolver cualquier otro error inesperado de la transacción de creación', async () => {
      const unexpected = new Error('fallo inesperado de base de datos');
      prisma.$transaction.mockImplementationOnce(() => {
        throw unexpected;
      });

      await expect(service.issue(makeCommand())).rejects.toThrow(unexpected);
    });
  });

  // ====================================================================
  // issue() — validación del emisor (§8)
  // ====================================================================
  describe('issue — validación del emisor (CompanySettings)', () => {
    it('businessName en blanco -> BadRequestException', async () => {
      tx.companySettings.findUnique.mockResolvedValue(
        makeCompanySettingsRow({ businessName: '   ' }),
      );
      await expect(service.issue(makeCommand())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('taxId ausente (null) -> BadRequestException', async () => {
      tx.companySettings.findUnique.mockResolvedValue(
        makeCompanySettingsRow({ taxId: null }),
      );
      await expect(service.issue(makeCommand())).rejects.toThrow(
        BadRequestException,
      );
    });

    it.each(['2010000000', '201000000012', '2010000000a', ''])(
      'taxId malformado "%s" -> BadRequestException',
      async (taxId) => {
        tx.companySettings.findUnique.mockResolvedValue(
          makeCompanySettingsRow({ taxId }),
        );
        await expect(service.issue(makeCommand())).rejects.toThrow(
          BadRequestException,
        );
      },
    );

    it('address en blanco -> BadRequestException', async () => {
      tx.companySettings.findUnique.mockResolvedValue(
        makeCompanySettingsRow({ address: '  ' }),
      );
      await expect(service.issue(makeCommand())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('address null -> BadRequestException', async () => {
      tx.companySettings.findUnique.mockResolvedValue(
        makeCompanySettingsRow({ address: null }),
      );
      await expect(service.issue(makeCommand())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('lee CompanySettings exactamente una vez por emisión', async () => {
      await service.issue(makeCommand());
      expect(tx.companySettings.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  // ====================================================================
  // issue() — validación FACTURA (§9)
  // ====================================================================
  describe('issue — validación FACTURA', () => {
    it('cliente genérico -> ConflictException', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({
          customerIsGeneric: true,
          customerDocumentType: null,
          customerDocumentNumber: null,
        }),
      );
      await expect(
        service.issue(
          makeCommand({ documentType: FiscalDocumentType.FACTURA }),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('cliente no-RUC (DNI) -> ConflictException', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({
          customerDocumentType: CustomerDocumentType.DNI,
          customerDocumentNumber: '12345678',
        }),
      );
      await expect(
        service.issue(
          makeCommand({ documentType: FiscalDocumentType.FACTURA }),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it.each(['2012345678', '201234567890', '2012345abc'])(
      'RUC malformado "%s" -> ConflictException',
      async (ruc) => {
        tx.sale.findUnique.mockResolvedValue(
          makeSaleRow({ customerDocumentNumber: ruc }),
        );
        await expect(
          service.issue(
            makeCommand({ documentType: FiscalDocumentType.FACTURA }),
          ),
        ).rejects.toThrow(ConflictException);
      },
    );

    it('RUC válido (11 numéricos) -> aceptado estructuralmente', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ customerDocumentNumber: '20123456789' }),
      );
      await expect(
        service.issue(
          makeCommand({ documentType: FiscalDocumentType.FACTURA }),
        ),
      ).resolves.toBeDefined();
    });

    it('nombre de cliente en blanco -> ConflictException', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ customerName: '   ' }),
      );
      await expect(
        service.issue(
          makeCommand({ documentType: FiscalDocumentType.FACTURA }),
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ====================================================================
  // issue() — validación BOLETA (§10)
  // ====================================================================
  describe('issue — validación BOLETA', () => {
    function makeBoletaSale(overrides: Partial<Record<string, unknown>> = {}) {
      return makeSaleRow({
        customerIsGeneric: true,
        customerDocumentType: null,
        customerDocumentNumber: null,
        customerName: 'Público general',
        total: new Prisma.Decimal('50.00'),
        ...overrides,
      });
    }

    it('genérico, total <= S/700 -> aceptado', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeBoletaSale({ total: new Prisma.Decimal('700.00') }),
      );
      await expect(
        service.issue(
          makeCommand({
            documentType: FiscalDocumentType.BOLETA,
            series: 'B001',
          }),
        ),
      ).resolves.toBeDefined();
    });

    it('identificado, total <= S/700 -> aceptado', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeBoletaSale({
          customerIsGeneric: false,
          customerDocumentType: CustomerDocumentType.DNI,
          customerDocumentNumber: '12345678',
          customerName: 'Juan Perez',
          total: new Prisma.Decimal('700.00'),
        }),
      );
      await expect(
        service.issue(
          makeCommand({
            documentType: FiscalDocumentType.BOLETA,
            series: 'B001',
          }),
        ),
      ).resolves.toBeDefined();
    });

    it('genérico, total > S/700 -> ConflictException', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeBoletaSale({ total: new Prisma.Decimal('700.01') }),
      );
      await expect(
        service.issue(
          makeCommand({
            documentType: FiscalDocumentType.BOLETA,
            series: 'B001',
          }),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('identificado, total > S/700 -> aceptado', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeBoletaSale({
          customerIsGeneric: false,
          customerDocumentType: CustomerDocumentType.DNI,
          customerDocumentNumber: '12345678',
          customerName: 'Juan Perez',
          total: new Prisma.Decimal('700.01'),
        }),
      );
      await expect(
        service.issue(
          makeCommand({
            documentType: FiscalDocumentType.BOLETA,
            series: 'B001',
          }),
        ),
      ).resolves.toBeDefined();
    });

    // §10: moneda distinta de PEN — decisión de diseño mínima y segura
    // reportada explícitamente (sin conversión de moneda inventada): se
    // exige SIEMPRE identificación completa, sin importar el monto.
    describe('moneda distinta de PEN (umbral no evaluable, sin conversión)', () => {
      it('genérico, moneda USD, monto bajo -> ConflictException (exige identificación)', async () => {
        tx.sale.findUnique.mockResolvedValue(
          makeBoletaSale({
            currencyCode: 'USD',
            total: new Prisma.Decimal('10.00'),
          }),
        );
        await expect(
          service.issue(
            makeCommand({
              documentType: FiscalDocumentType.BOLETA,
              series: 'B001',
            }),
          ),
        ).rejects.toThrow(ConflictException);
      });

      it('identificado, moneda USD -> aceptado (identificación siempre suficiente)', async () => {
        tx.sale.findUnique.mockResolvedValue(
          makeBoletaSale({
            currencyCode: 'USD',
            customerIsGeneric: false,
            customerDocumentType: CustomerDocumentType.DNI,
            customerDocumentNumber: '12345678',
            customerName: 'Juan Perez',
            total: new Prisma.Decimal('10.00'),
          }),
        );
        await expect(
          service.issue(
            makeCommand({
              documentType: FiscalDocumentType.BOLETA,
              series: 'B001',
            }),
          ),
        ).resolves.toBeDefined();
      });
    });
  });

  // ====================================================================
  // issue() — snapshot (§11-§13, §37 del kickoff)
  // ====================================================================
  describe('issue — snapshot congelado, nunca datos vigentes', () => {
    it('nunca lee la tabla customers: usa exclusivamente el snapshot de Sale', async () => {
      await service.issue(makeCommand());
      // El mock de tx no expone siquiera un modelo `customer`: cualquier
      // intento de leerlo fallaría en tiempo de ejecución. Este assert
      // documenta la intención explícitamente.
      expect((tx as Record<string, unknown>).customer).toBeUndefined();
    });

    it('copia currencyCode/subtotal/discountAmount/taxAmount/total EXACTOS de Sale, calcula taxableBase = subtotal - discountAmount', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({
          currencyCode: 'PEN',
          subtotal: new Prisma.Decimal('250.00'),
          discountAmount: new Prisma.Decimal('50.00'),
          taxAmount: new Prisma.Decimal('36.00'),
          total: new Prisma.Decimal('236.00'),
        }),
      );

      await service.issue(makeCommand());

      const call = tx.electronicDocument.create.mock.calls[0][0] as {
        data: Record<string, Prisma.Decimal> & { currencyCode: string };
      };
      expect(call.data.currencyCode).toBe('PEN');
      expect(call.data.subtotal.toFixed(2)).toBe('250.00');
      expect(call.data.discountAmount.toFixed(2)).toBe('50.00');
      expect(call.data.taxableBase.toFixed(2)).toBe('200.00');
      expect(call.data.taxAmount.toFixed(2)).toBe('36.00');
      expect(call.data.total.toFixed(2)).toBe('236.00');
    });

    it('nunca recalcula desde CompanySettings: cambiar businessName/taxId/address no altera el snapshot monetario ni de cliente', async () => {
      tx.companySettings.findUnique.mockResolvedValue(
        makeCompanySettingsRow({
          businessName: 'Otra Empresa Totalmente Distinta SAC',
          taxId: '20999999999',
          address: 'Otra dirección 999',
        }),
      );

      await service.issue(makeCommand());

      const call = tx.electronicDocument.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.customerName).toBe('Distribuidora Fiscal SAC');
      expect(call.data.issuerBusinessName).toBe(
        'Otra Empresa Totalmente Distinta SAC',
      );
    });
  });

  // ====================================================================
  // issue() — snapshot de ítems y numeración estable (§14, §37)
  // ====================================================================
  describe('issue — snapshot de ítems', () => {
    it('copia productSku/description/unit*/quantity/unitPrice/lineTotal exactos de SaleItem, con lineNumber 1..N', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({
          items: [
            makeSaleItemRow({ productSku: 'SKU-A', productName: 'Producto A' }),
            makeSaleItemRow({ productSku: 'SKU-B', productName: 'Producto B' }),
          ],
        }),
      );

      await service.issue(makeCommand());

      const call = tx.electronicDocument.create.mock.calls[0][0] as {
        data: { items: { create: Record<string, unknown>[] } };
      };
      const items = call.data.items.create;
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        lineNumber: 1,
        productSku: 'SKU-A',
        description: 'Producto A',
      });
      expect(items[1]).toMatchObject({
        lineNumber: 2,
        productSku: 'SKU-B',
        description: 'Producto B',
      });
    });

    it('ordena los ítems de forma determinista (createdAt asc, id asc) al leer SaleItem', async () => {
      await service.issue(makeCommand());

      const call = tx.sale.findUnique.mock.calls[0][0] as {
        select: { items: { orderBy: unknown } };
      };
      expect(call.select.items.orderBy).toEqual([
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
    });
  });

  // ====================================================================
  // issue() — serie fiscal explícita (§5/§15)
  // ====================================================================
  describe('issue — serie fiscal explícita', () => {
    it('nunca selecciona automáticamente una serie: pasa exactamente documentType/series del comando a FiscalSeriesService', async () => {
      await service.issue(
        makeCommand({
          documentType: FiscalDocumentType.FACTURA,
          series: 'F001',
        }),
      );
      expect(fiscalSeriesService.allocateNext).toHaveBeenCalledWith(
        tx,
        FiscalDocumentType.FACTURA,
        'F001',
      );
    });

    it('propaga sin envolver el error de FiscalSeriesService (serie inexistente/inactiva/agotada)', async () => {
      fiscalSeriesService.allocateNext.mockRejectedValue(
        new NotFoundException('no existe la serie'),
      );
      await expect(service.issue(makeCommand())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ====================================================================
  // issue() — proveedor: flujo y outcomes (§18/§24-§29)
  // ====================================================================
  describe('issue — flujo de proveedor', () => {
    it('el proveedor se llama DESPUÉS de que la transacción de creación ya resolvió (fuera de cualquier tx)', async () => {
      const callOrder: string[] = [];
      prisma.$transaction.mockImplementation(
        (cb: (t: typeof tx) => unknown) => {
          callOrder.push('tx-start');
          const result = cb(tx);
          callOrder.push('tx-end');
          return Promise.resolve(result);
        },
      );
      provider.submit.mockImplementation(() => {
        callOrder.push('provider-submit');
        return Promise.resolve({
          outcome: 'ACCEPTED',
          externalId: 'ext-1',
          providerStatus: 'ACCEPTED',
          providerMessage: 'ok',
        });
      });

      await service.issue(makeCommand());

      // provider-submit ocurre estrictamente entre el fin de la transacción
      // de creación/transición y el inicio de la transacción de resultado:
      // nunca dentro de un 'tx-start' sin su 'tx-end' correspondiente.
      const submitIndex = callOrder.indexOf('provider-submit');
      const txStartsBefore = callOrder
        .slice(0, submitIndex)
        .filter((e) => e === 'tx-start').length;
      const txEndsBefore = callOrder
        .slice(0, submitIndex)
        .filter((e) => e === 'tx-end').length;
      expect(txStartsBefore).toBe(txEndsBefore);
    });

    it('ACCEPTED: persiste providerExternalId/providerStatus/providerMessage/acceptedAt, rejectedAt null, audita ELECTRONIC_DOCUMENT_ACCEPTED', async () => {
      const result = await service.issue(makeCommand());

      expect(result.status).toBe(ElectronicDocumentStatus.ACCEPTED);
      expect(result.acceptedAt).not.toBeNull();
      expect(result.rejectedAt).toBeNull();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ELECTRONIC_DOCUMENT_ACCEPTED,
        }),
      );
    });

    it('REJECTED: transiciona a REJECTED, persiste rejectedAt, acceptedAt null, audita ELECTRONIC_DOCUMENT_REJECTED', async () => {
      provider.submit.mockResolvedValue({
        outcome: 'REJECTED',
        externalId: null,
        providerStatus: 'RUC_INVALIDO',
        providerMessage: 'Rechazado por el proveedor (demo)',
      });
      tx.electronicDocument.update.mockResolvedValue(
        makeElectronicDocumentSafeRow({
          status: ElectronicDocumentStatus.REJECTED,
          providerStatus: 'RUC_INVALIDO',
          providerMessage: 'Rechazado por el proveedor (demo)',
          rejectedAt: new Date('2026-03-15T12:00:02.000Z'),
        }),
      );

      const result = await service.issue(makeCommand());

      expect(result.status).toBe(ElectronicDocumentStatus.REJECTED);
      expect(result.rejectedAt).not.toBeNull();
      expect(result.acceptedAt).toBeNull();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ELECTRONIC_DOCUMENT_REJECTED,
        }),
      );
    });

    // ==================================================================
    // Remediación final del Bloque 11C — certeza del outcome del proveedor
    // ==================================================================

    it('§12 falla DEFINITIVA (RetryableProviderSubmissionError): SUBMISSION_FAILED, auditada, reintentable, sin exponer el mensaje crudo', async () => {
      const rawError = new RetryableProviderSubmissionError(
        'ECONNREFUSED: detalle interno de red',
      );
      provider.submit.mockRejectedValue(rawError);

      await expect(service.issue(makeCommand())).rejects.toThrow(
        ServiceUnavailableException,
      );

      const updateCall = tx.electronicDocument.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.status).toBe(
        ElectronicDocumentStatus.SUBMISSION_FAILED,
      );
      expect(updateCall.data.providerStatus).toBe('TECHNICAL_FAILURE');
      expect(updateCall.data.acceptedAt).toBeNull();
      expect(updateCall.data.rejectedAt).toBeNull();
      expect(JSON.stringify(updateCall.data)).not.toContain('ECONNREFUSED');

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ELECTRONIC_DOCUMENT_SUBMISSION_FAILED,
        }),
      );
      const auditCall = auditService.record.mock.calls.find(
        (call) =>
          (call[0] as { action: AuditAction }).action ===
          AuditAction.ELECTRONIC_DOCUMENT_SUBMISSION_FAILED,
      )?.[0] as { metadata: Record<string, unknown> };
      expect(JSON.stringify(auditCall.metadata)).not.toContain('ECONNREFUSED');
    });

    it('§13 resultado DESCONOCIDO clasificado (UnknownProviderSubmissionOutcomeError): permanece SUBMITTED, sin auditoría de SUBMISSION_FAILED, diagnóstico genérico', async () => {
      provider.submit.mockRejectedValue(
        new UnknownProviderSubmissionOutcomeError(
          'timeout: sin confirmación del proveedor',
        ),
      );

      await expect(service.issue(makeCommand())).rejects.toThrow(
        ServiceUnavailableException,
      );

      const updateCall = tx.electronicDocument.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      // Nunca se toca `status`: el documento queda exactamente en el
      // SUBMITTED que dejó transitionToSubmitted().
      expect(updateCall.data.status).toBeUndefined();
      expect(updateCall.data.providerStatus).toBe('UNKNOWN_OUTCOME');
      expect(JSON.stringify(updateCall.data)).not.toContain('timeout');

      expect(auditService.record).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ELECTRONIC_DOCUMENT_SUBMISSION_FAILED,
        }),
      );
    });

    it('§14 error GENÉRICO no clasificado: se trata igual que un resultado desconocido (fail closed) — permanece SUBMITTED, texto crudo nunca persistido ni auditado', async () => {
      provider.submit.mockRejectedValue(
        new Error('raw sensitive provider failure'),
      );

      await expect(service.issue(makeCommand())).rejects.toThrow(
        ServiceUnavailableException,
      );

      const updateCall = tx.electronicDocument.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.status).toBeUndefined();
      expect(updateCall.data.providerStatus).toBe('UNKNOWN_OUTCOME');
      expect(JSON.stringify(updateCall.data)).not.toContain(
        'raw sensitive provider failure',
      );

      expect(auditService.record).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ELECTRONIC_DOCUMENT_SUBMISSION_FAILED,
        }),
      );
      for (const call of auditService.record.mock.calls) {
        expect(JSON.stringify(call[0])).not.toContain(
          'raw sensitive provider failure',
        );
      }

      // SUBMITTED nunca es reintentable: retrySubmission() solo admite
      // SUBMISSION_FAILED (probado en el describe de abajo).
    });

    it('el número/serie ya asignados permanecen consumidos tras cualquier clasificación de fallo (no se revierte la asignación)', async () => {
      provider.submit.mockRejectedValue(
        new RetryableProviderSubmissionError('timeout'),
      );

      await expect(service.issue(makeCommand())).rejects.toThrow(
        ServiceUnavailableException,
      );

      // La transacción de creación (con el número ya asignado) ya había
      // comprometido antes de que el proveedor fallara: no hay ningún
      // rollback de esa transacción disparado por el fallo del proveedor.
      expect(fiscalSeriesService.allocateNext).toHaveBeenCalledTimes(1);
      expect(tx.electronicDocument.create).toHaveBeenCalledTimes(1);
    });
  });

  // ====================================================================
  // retrySubmission() (§30/§40)
  // ====================================================================
  describe('retrySubmission', () => {
    it('reintenta un documento en SUBMISSION_FAILED: mismo documento, sin asignar otro número fiscal', async () => {
      const result = await service.retrySubmission(DOCUMENT_ID, ACTOR_ID, null);

      expect(result).toBeDefined();
      expect(fiscalSeriesService.allocateNext).not.toHaveBeenCalled();
      expect(tx.electronicDocument.create).not.toHaveBeenCalled();
      const sql = tx.$queryRaw.mock.calls[0][0];
      expect(sql.strings.join(' ')).toContain('UPDATE electronic_documents');
    });

    it('incrementa submissionCount en cada reintento (vía el UPDATE de transición)', async () => {
      await service.retrySubmission(DOCUMENT_ID, ACTOR_ID, null);
      const sql = tx.$queryRaw.mock.calls[0][0];
      expect(sql.strings.join(' ')).toContain(
        'submission_count = submission_count + 1',
      );
    });

    it.each([
      ElectronicDocumentStatus.CREATED,
      ElectronicDocumentStatus.SUBMITTED,
      ElectronicDocumentStatus.ACCEPTED,
      ElectronicDocumentStatus.REJECTED,
    ])(
      'rechaza el reintento si el documento está en %s -> ConflictException',
      async (status) => {
        tx.$queryRaw.mockResolvedValue([]);
        tx.electronicDocument.findUnique.mockResolvedValue({ status });

        await expect(
          service.retrySubmission(DOCUMENT_ID, ACTOR_ID, null),
        ).rejects.toThrow(ConflictException);
        expect(provider.submit).not.toHaveBeenCalled();
      },
    );

    it('documento inexistente -> NotFoundException', async () => {
      tx.$queryRaw.mockResolvedValue([]);
      tx.electronicDocument.findUnique.mockResolvedValue(null);

      await expect(
        service.retrySubmission(DOCUMENT_ID, ACTOR_ID, null),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
