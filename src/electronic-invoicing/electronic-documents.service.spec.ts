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
  RoleName,
  SaleStatus,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { SaleAccessRequester } from '../sales/sale-access.policy';
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
/** P6-C2: vendedor por defecto de la venta fixture (distinto de ACTOR_ID). */
const SALE_SELLER_ID = 'seller-owner-of-sale';

/** Mismo helper que PaymentsService.list()/QuotesService.findOne() (P1-P6). */
function asRole(role: RoleName, id: string = ACTOR_ID): SaleAccessRequester {
  return { id, role };
}

function makeSaleRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SALE_ID,
    number: SALE_NUMBER,
    status: SaleStatus.ACTIVE,
    sellerId: SALE_SELLER_ID,
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
    pricesIncludeTax: false,
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
    actorRole: RoleName.ADMIN,
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
    // Bloque 11D: list()/findDetail() leen directamente, sin transacción.
    electronicDocument: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
      count: jest.fn<Promise<number>, [Record<string, unknown>]>(),
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
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
  // issue() — P6-C2: autorización por propiedad de la venta
  // ====================================================================
  describe('issue — P6-C2 autorización por propiedad de la venta', () => {
    const OWN_SELLER_ID = SALE_SELLER_ID;
    const OTHER_SELLER_ID = 'other-seller-id';

    it('1. SELLER emite el comprobante de su propia venta', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ sellerId: OWN_SELLER_ID }),
      );

      await expect(
        service.issue(
          makeCommand({
            actorUserId: OWN_SELLER_ID,
            actorRole: RoleName.SELLER,
          }),
        ),
      ).resolves.toBeDefined();
      expect(fiscalSeriesService.allocateNext).toHaveBeenCalled();
    });

    it('2. SELLER intenta emitir sobre la venta del ADMIN (ajena) -> 404, sin efectos', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ sellerId: 'admin-id' }),
      );

      await expect(
        service.issue(
          makeCommand({
            actorUserId: OWN_SELLER_ID,
            actorRole: RoleName.SELLER,
          }),
        ),
      ).rejects.toThrow(new NotFoundException('La venta no existe'));
      expect(fiscalSeriesService.allocateNext).not.toHaveBeenCalled();
      expect(tx.electronicDocument.create).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('3. SELLER intenta emitir sobre la venta de OTRO SELLER (ajena) -> 404', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ sellerId: OTHER_SELLER_ID }),
      );

      await expect(
        service.issue(
          makeCommand({
            actorUserId: OWN_SELLER_ID,
            actorRole: RoleName.SELLER,
          }),
        ),
      ).rejects.toThrow(new NotFoundException('La venta no existe'));
    });

    it('4. venta ajena e inexistente producen el MISMO 404 ("La venta no existe")', async () => {
      tx.sale.findUnique.mockResolvedValue(null);
      await expect(
        service.issue(
          makeCommand({
            actorUserId: OWN_SELLER_ID,
            actorRole: RoleName.SELLER,
          }),
        ),
      ).rejects.toThrow(new NotFoundException('La venta no existe'));

      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ sellerId: OTHER_SELLER_ID }),
      );
      await expect(
        service.issue(
          makeCommand({
            actorUserId: OWN_SELLER_ID,
            actorRole: RoleName.SELLER,
          }),
        ),
      ).rejects.toThrow(new NotFoundException('La venta no existe'));
    });

    it('5a. venta ajena CANCELLED responde 404 (propiedad antes que estado), no 409', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({
          sellerId: OTHER_SELLER_ID,
          status: SaleStatus.CANCELLED,
        }),
      );

      await expect(
        service.issue(
          makeCommand({
            actorUserId: OWN_SELLER_ID,
            actorRole: RoleName.SELLER,
          }),
        ),
      ).rejects.toThrow(new NotFoundException('La venta no existe'));
    });

    it('5b. venta ajena ya facturada responde 404 (propiedad antes que documento primario), no 409', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ sellerId: OTHER_SELLER_ID }),
      );
      tx.electronicDocument.findFirst.mockResolvedValue({ id: 'existing-doc' });

      await expect(
        service.issue(
          makeCommand({
            actorUserId: OWN_SELLER_ID,
            actorRole: RoleName.SELLER,
          }),
        ),
      ).rejects.toThrow(new NotFoundException('La venta no existe'));
      // La propiedad se resuelve ANTES de siquiera consultar el documento
      // primario existente.
      expect(tx.electronicDocument.findFirst).not.toHaveBeenCalled();
    });

    it('6. la propiedad se comprueba antes de validar cliente/serie: BOLETA inválida de una venta ajena sigue dando 404, no 409', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({
          sellerId: OTHER_SELLER_ID,
          customerIsGeneric: true, // inválido para FACTURA (§9)
        }),
      );

      await expect(
        service.issue(
          makeCommand({
            actorUserId: OWN_SELLER_ID,
            actorRole: RoleName.SELLER,
            documentType: FiscalDocumentType.FACTURA,
          }),
        ),
      ).rejects.toThrow(new NotFoundException('La venta no existe'));
    });

    it('7. la autorización usa el sellerId REAL de la fila cargada, nunca un valor derivado del comando', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ sellerId: OWN_SELLER_ID }),
      );

      await service.issue(
        makeCommand({ actorUserId: OWN_SELLER_ID, actorRole: RoleName.SELLER }),
      );

      // loadSaleSnapshot consulta por el id de la venta solicitada, nunca
      // filtrando por el actor: la propiedad se decide DESPUÉS de leerla.
      const call = tx.sale.findUnique.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({ id: SALE_ID });
    });

    it('8. ninguna emisión denegada reserva numeración, crea el documento ni audita', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ sellerId: OTHER_SELLER_ID }),
      );

      await expect(
        service.issue(
          makeCommand({
            actorUserId: OWN_SELLER_ID,
            actorRole: RoleName.SELLER,
          }),
        ),
      ).rejects.toThrow(NotFoundException);

      expect(fiscalSeriesService.allocateNext).not.toHaveBeenCalled();
      expect(tx.electronicDocument.create).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
      expect(provider.submit).not.toHaveBeenCalled();
    });

    it('9. ADMIN emite el comprobante de una venta de SELLER sin restricción', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ sellerId: OWN_SELLER_ID }),
      );

      await expect(
        service.issue(
          makeCommand({ actorUserId: 'admin-id', actorRole: RoleName.ADMIN }),
        ),
      ).resolves.toBeDefined();
    });

    it('10. la emisión nunca escribe sobre Sale (sellerId original intacto): sin tx.sale.update definido ni invocado', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ sellerId: OWN_SELLER_ID }),
      );

      await service.issue(
        makeCommand({ actorUserId: OWN_SELLER_ID, actorRole: RoleName.SELLER }),
      );

      expect(
        (tx.sale as unknown as { update?: unknown }).update,
      ).toBeUndefined();
    });

    it('11. la auditoría registra al actor REAL como emisor, incluso emitiendo sobre una venta ajena permitida (ADMIN)', async () => {
      tx.sale.findUnique.mockResolvedValue(
        makeSaleRow({ sellerId: OWN_SELLER_ID }),
      );

      await service.issue(
        makeCommand({ actorUserId: 'admin-id', actorRole: RoleName.ADMIN }),
      );

      const call = auditService.record.mock.calls[0][0] as {
        userId: string;
      };
      expect(call.userId).toBe('admin-id');
    });

    it.each([RoleName.MANAGEMENT, RoleName.WAREHOUSE])(
      '12. %s no recibe permisos de emisión: 404 también a nivel de servicio (defensa en profundidad)',
      async (role) => {
        tx.sale.findUnique.mockResolvedValue(
          makeSaleRow({ sellerId: OWN_SELLER_ID }),
        );

        await expect(
          service.issue(
            makeCommand({ actorUserId: OWN_SELLER_ID, actorRole: role }),
          ),
        ).rejects.toThrow(new NotFoundException('La venta no existe'));
      },
    );
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

    it.each([false, true])(
      'R2-B1: copia pricesIncludeTax=%s VERBATIM de Sale (y lo lee en el select de la venta)',
      async (pricesIncludeTax) => {
        tx.sale.findUnique.mockResolvedValue(makeSaleRow({ pricesIncludeTax }));

        await service.issue(makeCommand());

        const findArgs = tx.sale.findUnique.mock.calls[0][0] as {
          select: Record<string, unknown>;
        };
        expect(findArgs.select.pricesIncludeTax).toBe(true);
        const call = tx.electronicDocument.create.mock.calls[0][0] as {
          data: Record<string, unknown>;
        };
        expect(call.data.pricesIncludeTax).toBe(pricesIncludeTax);
      },
    );

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

  // ====================================================================
  // Bloque 11D — list()/findDetail()
  // ====================================================================
  describe('list', () => {
    function makeListRow(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: DOCUMENT_ID,
        saleId: SALE_ID,
        sale: { number: SALE_NUMBER },
        documentType: FiscalDocumentType.FACTURA,
        series: 'F001',
        number: 7,
        status: ElectronicDocumentStatus.ACCEPTED,
        currencyCode: 'PEN',
        customerDocumentType: CustomerDocumentType.RUC,
        customerDocumentNumber: '20123456789',
        customerName: 'Distribuidora Fiscal SAC',
        subtotal: new Prisma.Decimal('100.00'),
        discountAmount: new Prisma.Decimal('0.00'),
        taxableBase: new Prisma.Decimal('100.00'),
        taxAmount: new Prisma.Decimal('18.00'),
        total: new Prisma.Decimal('118.00'),
        providerCode: 'MOCK',
        providerStatus: 'ACCEPTED',
        issuedAt: new Date('2026-03-15T12:00:00.000Z'),
        lastSubmittedAt: new Date('2026-03-15T12:00:01.000Z'),
        acceptedAt: new Date('2026-03-15T12:00:02.000Z'),
        rejectedAt: null,
        createdAt: new Date('2026-03-15T12:00:00.000Z'),
        updatedAt: new Date('2026-03-15T12:00:02.000Z'),
        ...overrides,
      };
    }

    beforeEach(() => {
      prisma.electronicDocument.findMany.mockResolvedValue([makeListRow()]);
      prisma.electronicDocument.count.mockResolvedValue(1);
    });

    it('nunca selecciona items (select de listado sin relación anidada)', async () => {
      await service.list({}, asRole(RoleName.ADMIN));

      const call = prisma.electronicDocument.findMany.mock.calls[0][0] as {
        select: Record<string, unknown>;
      };
      expect(call.select).not.toHaveProperty('items');
    });

    it('computa fullNumber y nunca expone providerExternalId', async () => {
      const result = await service.list({}, asRole(RoleName.ADMIN));

      expect(result.data[0].fullNumber).toBe('F001-00000007');
      expect(result.data[0]).not.toHaveProperty('providerExternalId');
      expect(result.data[0].saleNumber).toBe(SALE_NUMBER);
    });

    it('pagina con page/limit por defecto y respeta el máximo de 100', async () => {
      await service.list({ limit: 500 }, asRole(RoleName.ADMIN));

      const call = prisma.electronicDocument.findMany.mock.calls[0][0] as {
        take: number;
        skip: number;
      };
      expect(call.take).toBe(100);
      expect(call.skip).toBe(0);
    });

    it('ordena issuedAt desc, id desc', async () => {
      await service.list({}, asRole(RoleName.ADMIN));

      const call = prisma.electronicDocument.findMany.mock.calls[0][0] as {
        orderBy: unknown;
      };
      expect(call.orderBy).toEqual([{ issuedAt: 'desc' }, { id: 'desc' }]);
    });

    it.each([
      ['documentType', { documentType: FiscalDocumentType.BOLETA }],
      ['status', { status: ElectronicDocumentStatus.SUBMITTED }],
      ['series', { series: 'F001' }],
      ['saleId', { saleId: SALE_ID }],
      ['customerDocumentNumber', { customerDocumentNumber: '20123456789' }],
    ])('aplica el filtro %s', async (_name, filter) => {
      await service.list(filter, asRole(RoleName.ADMIN));

      const call = prisma.electronicDocument.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] };
      };
      expect(call.where.AND).toContainEqual(filter);
    });

    it('issuedFrom posterior a issuedTo -> BadRequestException', async () => {
      await expect(
        service.list(
          { issuedFrom: '2026-03-31', issuedTo: '2026-03-01' },
          asRole(RoleName.ADMIN),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    // ==================================================================
    // P6-C1 — alcance por propiedad (ElectronicDocument -> Sale.sellerId)
    // ==================================================================
    describe('permisos por vendedor (P6-C1)', () => {
      const OWN_SELLER_ID = 'seller-own';

      function whereOf(call: 'findMany' | 'count'): unknown {
        return (
          prisma.electronicDocument[call].mock.calls[0][0] as {
            where: unknown;
          }
        ).where;
      }

      it('ADMIN: sin condición de venta', async () => {
        await service.list({}, asRole(RoleName.ADMIN));
        expect(whereOf('findMany')).toEqual({});
      });

      it('MANAGEMENT: sin condición de venta', async () => {
        await service.list({}, asRole(RoleName.MANAGEMENT));
        expect(whereOf('findMany')).toEqual({});
      });

      it('SELLER sin filtros: AND por la venta asociada (sale.sellerId = actor)', async () => {
        await service.list({}, asRole(RoleName.SELLER, OWN_SELLER_ID));
        expect(whereOf('findMany')).toEqual({
          AND: [{ sale: { sellerId: OWN_SELLER_ID } }, {}],
        });
      });

      it('SELLER con saleId ajeno: el filtro no amplía el alcance (AND, no OR)', async () => {
        await service.list(
          { saleId: SALE_ID },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );
        expect(whereOf('findMany')).toEqual({
          AND: [
            { sale: { sellerId: OWN_SELLER_ID } },
            { AND: [{ saleId: SALE_ID }] },
          ],
        });
      });

      it('findMany y count usan exactamente el mismo where restringido', async () => {
        await service.list(
          { documentType: FiscalDocumentType.FACTURA },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );
        expect(whereOf('count')).toEqual(whereOf('findMany'));
      });

      it('WAREHOUSE: página vacía sin consultar Prisma', async () => {
        const result = await service.list({}, asRole(RoleName.WAREHOUSE));
        expect(result).toEqual({
          data: [],
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        });
        expect(prisma.electronicDocument.findMany).not.toHaveBeenCalled();
        expect(prisma.electronicDocument.count).not.toHaveBeenCalled();
      });
    });
  });

  describe('findDetail', () => {
    // Por defecto, documento HISTÓRICO (pricesIncludeTax=false): base 100.00
    // + IGV 18.00 sumado = 118.00. La venta de origen aporta su contexto de
    // impuesto congelado (R2-B5).
    function makeDetailRow(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: DOCUMENT_ID,
        saleId: SALE_ID,
        sale: {
          number: SALE_NUMBER,
          taxEnabled: true,
          taxRate: new Prisma.Decimal('18.00'),
        },
        pricesIncludeTax: false,
        documentType: FiscalDocumentType.FACTURA,
        series: 'F001',
        number: 7,
        status: ElectronicDocumentStatus.ACCEPTED,
        currencyCode: 'PEN',
        customerDocumentType: CustomerDocumentType.RUC,
        customerDocumentNumber: '20123456789',
        customerName: 'Distribuidora Fiscal SAC',
        subtotal: new Prisma.Decimal('100.00'),
        discountAmount: new Prisma.Decimal('0.00'),
        taxableBase: new Prisma.Decimal('100.00'),
        taxAmount: new Prisma.Decimal('18.00'),
        total: new Prisma.Decimal('118.00'),
        providerCode: 'MOCK',
        providerStatus: 'ACCEPTED',
        issuedAt: new Date('2026-03-15T12:00:00.000Z'),
        lastSubmittedAt: new Date('2026-03-15T12:00:01.000Z'),
        acceptedAt: new Date('2026-03-15T12:00:02.000Z'),
        rejectedAt: null,
        createdAt: new Date('2026-03-15T12:00:00.000Z'),
        updatedAt: new Date('2026-03-15T12:00:02.000Z'),
        issuerTaxId: '20100000001',
        issuerBusinessName: 'Empresa Demo SAC',
        issuerAddress: 'Av. Principal 100',
        customerAddress: 'Av. Siempre Viva 123',
        providerMessage:
          'Documento aceptado por el proveedor de demostración (MOCK).',
        submissionCount: 1,
        items: [
          {
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

    it('documento inexistente -> NotFoundException', async () => {
      prisma.electronicDocument.findUnique.mockResolvedValue(null);

      await expect(service.findDetail(DOCUMENT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('devuelve items, issuer, providerMessage/submissionCount, nunca providerExternalId', async () => {
      prisma.electronicDocument.findUnique.mockResolvedValue(makeDetailRow());

      const result = await service.findDetail(DOCUMENT_ID);

      expect(result.fullNumber).toBe('F001-00000007');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].productSku).toBe('SKU-001');
      expect(result.issuerBusinessName).toBe('Empresa Demo SAC');
      expect(result.submissionCount).toBe(1);
      expect(result).not.toHaveProperty('providerExternalId');
    });

    it('el select de detalle carga los ítems en un único nested select (sin N+1)', async () => {
      prisma.electronicDocument.findUnique.mockResolvedValue(makeDetailRow());

      await service.findDetail(DOCUMENT_ID);

      const call = prisma.electronicDocument.findUnique.mock.calls[0][0] as {
        select: { items: unknown };
      };
      expect(call.select.items).toBeDefined();
    });

    it('R2-B5: el select de detalle lee pricesIncludeTax y el contexto de impuesto congelado de la venta (nunca CompanySettings)', async () => {
      prisma.electronicDocument.findUnique.mockResolvedValue(makeDetailRow());

      await service.findDetail(DOCUMENT_ID);

      const call = prisma.electronicDocument.findUnique.mock.calls[0][0] as {
        select: {
          pricesIncludeTax: boolean;
          sale: { select: Record<string, boolean> };
        };
      };
      expect(call.select.pricesIncludeTax).toBe(true);
      expect(call.select.sale.select).toEqual({
        number: true,
        taxEnabled: true,
        taxRate: true,
      });
    });

    it('R2-B5: documento HISTÓRICO: pricesIncludeTax=false y descuento al cliente = discountAmount persistido', async () => {
      prisma.electronicDocument.findUnique.mockResolvedValue(
        makeDetailRow({
          subtotal: new Prisma.Decimal('100.00'),
          discountAmount: new Prisma.Decimal('10.00'),
          taxableBase: new Prisma.Decimal('90.00'),
          taxAmount: new Prisma.Decimal('16.20'),
          total: new Prisma.Decimal('106.20'),
        }),
      );

      const result = await service.findDetail(DOCUMENT_ID);

      expect(result).toMatchObject({
        pricesIncludeTax: false,
        taxEnabled: true,
        taxRate: '18.00',
        itemsTotal: '100.00',
        customerDiscountAmount: '10.00',
        // Campos existentes intactos.
        subtotal: '100.00',
        discountAmount: '10.00',
        taxableBase: '90.00',
        taxAmount: '16.20',
        total: '106.20',
      });
    });

    it('R2-B5: documento con precios finales: descuento al cliente = Σ lineTotal - total (118.00 - 106.20 = 11.80)', async () => {
      prisma.electronicDocument.findUnique.mockResolvedValue(
        makeDetailRow({
          pricesIncludeTax: true,
          subtotal: new Prisma.Decimal('100.00'),
          discountAmount: new Prisma.Decimal('10.00'),
          taxableBase: new Prisma.Decimal('90.00'),
          taxAmount: new Prisma.Decimal('16.20'),
          total: new Prisma.Decimal('106.20'),
          items: [
            {
              lineNumber: 1,
              productSku: 'SKU-001',
              description: 'Producto Fiscal',
              unitCode: 'UND',
              unitName: 'Unidad',
              unitAbbreviation: 'und',
              quantity: new Prisma.Decimal('1.000'),
              unitPrice: new Prisma.Decimal('118.00'),
              lineTotal: new Prisma.Decimal('118.00'),
            },
          ],
        }),
      );

      const result = await service.findDetail(DOCUMENT_ID);

      expect(result).toMatchObject({
        pricesIncludeTax: true,
        itemsTotal: '118.00',
        customerDiscountAmount: '11.80',
        discountAmount: '10.00',
        taxableBase: '90.00',
        taxAmount: '16.20',
        total: '106.20',
      });
    });
  });

  // ====================================================================
  // P6-C1 — findDetailForRequester() (alcance por propiedad de la venta)
  // ====================================================================
  describe('findDetailForRequester', () => {
    const OWN_SELLER_ID = 'seller-own';

    function makeDetailRow(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: DOCUMENT_ID,
        saleId: SALE_ID,
        sale: {
          number: SALE_NUMBER,
          taxEnabled: true,
          taxRate: new Prisma.Decimal('18.00'),
        },
        pricesIncludeTax: false,
        documentType: FiscalDocumentType.FACTURA,
        series: 'F001',
        number: 7,
        status: ElectronicDocumentStatus.ACCEPTED,
        currencyCode: 'PEN',
        customerDocumentType: CustomerDocumentType.RUC,
        customerDocumentNumber: '20123456789',
        customerName: 'Distribuidora Fiscal SAC',
        subtotal: new Prisma.Decimal('100.00'),
        discountAmount: new Prisma.Decimal('0.00'),
        taxableBase: new Prisma.Decimal('100.00'),
        taxAmount: new Prisma.Decimal('18.00'),
        total: new Prisma.Decimal('118.00'),
        providerCode: 'MOCK',
        providerStatus: 'ACCEPTED',
        issuedAt: new Date('2026-03-15T12:00:00.000Z'),
        lastSubmittedAt: new Date('2026-03-15T12:00:01.000Z'),
        acceptedAt: new Date('2026-03-15T12:00:02.000Z'),
        rejectedAt: null,
        createdAt: new Date('2026-03-15T12:00:00.000Z'),
        updatedAt: new Date('2026-03-15T12:00:02.000Z'),
        issuerTaxId: '20100000001',
        issuerBusinessName: 'Empresa Demo SAC',
        issuerAddress: 'Av. Principal 100',
        customerAddress: 'Av. Siempre Viva 123',
        providerMessage:
          'Documento aceptado por el proveedor de demostración (MOCK).',
        submissionCount: 1,
        items: [
          {
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

    it('documento inexistente -> NotFoundException ("El documento fiscal no existe")', async () => {
      prisma.electronicDocument.findUnique.mockResolvedValue(null);

      await expect(
        service.findDetailForRequester(DOCUMENT_ID, asRole(RoleName.ADMIN)),
      ).rejects.toThrow(new NotFoundException('El documento fiscal no existe'));
    });

    it('ADMIN: consulta sin condición de venta', async () => {
      prisma.electronicDocument.findUnique.mockResolvedValue(makeDetailRow());

      await service.findDetailForRequester(DOCUMENT_ID, asRole(RoleName.ADMIN));

      const call = prisma.electronicDocument.findUnique.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({ id: DOCUMENT_ID });
    });

    it('MANAGEMENT: consulta sin condición de venta', async () => {
      prisma.electronicDocument.findUnique.mockResolvedValue(makeDetailRow());

      await service.findDetailForRequester(
        DOCUMENT_ID,
        asRole(RoleName.MANAGEMENT),
      );

      const call = prisma.electronicDocument.findUnique.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({ id: DOCUMENT_ID });
    });

    it('SELLER: combina el id con la condición de venta (sale.sellerId = actor)', async () => {
      prisma.electronicDocument.findUnique.mockResolvedValue(makeDetailRow());

      await service.findDetailForRequester(
        DOCUMENT_ID,
        asRole(RoleName.SELLER, OWN_SELLER_ID),
      );

      const call = prisma.electronicDocument.findUnique.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({
        id: DOCUMENT_ID,
        sale: { sellerId: OWN_SELLER_ID },
      });
    });

    it('SELLER: documento de una venta ajena (Prisma no encuentra fila) -> MISMO 404 que inexistente', async () => {
      prisma.electronicDocument.findUnique.mockResolvedValue(null);

      await expect(
        service.findDetailForRequester(
          DOCUMENT_ID,
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        ),
      ).rejects.toThrow(new NotFoundException('El documento fiscal no existe'));
    });

    it('SELLER: documento de su propia venta -> detalle normal', async () => {
      prisma.electronicDocument.findUnique.mockResolvedValue(makeDetailRow());

      const result = await service.findDetailForRequester(
        DOCUMENT_ID,
        asRole(RoleName.SELLER, OWN_SELLER_ID),
      );

      expect(result.id).toBe(DOCUMENT_ID);
      expect(result.items).toHaveLength(1);
    });

    it('WAREHOUSE: 404 sin consultar Prisma (sin ningún acceso de lectura)', async () => {
      await expect(
        service.findDetailForRequester(DOCUMENT_ID, asRole(RoleName.WAREHOUSE)),
      ).rejects.toThrow(new NotFoundException('El documento fiscal no existe'));
      expect(prisma.electronicDocument.findUnique).not.toHaveBeenCalled();
    });

    it('no escribe ni altera el documento (solo lectura)', async () => {
      prisma.electronicDocument.findUnique.mockResolvedValue(makeDetailRow());

      await service.findDetailForRequester(
        DOCUMENT_ID,
        asRole(RoleName.SELLER, OWN_SELLER_ID),
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
