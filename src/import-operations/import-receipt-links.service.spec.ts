import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PurchaseReceiptStatus, RoleName } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SettingsReader } from '../configuration/settings-reader.service';
import { PrismaService } from '../database/prisma.service';
import { ImportReceiptLinksService } from './import-receipt-links.service';

const ACTOR_ID = 'actor-id';
const SHIPMENT_LINE_ID = 'shipment-line-1';
const RECEIPT_LINE_ID = 'receipt-line-1';
const LINK_ID = 'link-1';
const NOW = new Date('2026-01-01T00:00:00.000Z');

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function makeActor() {
  return {
    id: ACTOR_ID,
    username: 'admin',
    firstName: 'Ana',
    lastName: 'Admin',
  };
}

function makeLinkRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: LINK_ID,
    importShipmentLineId: SHIPMENT_LINE_ID,
    purchaseReceiptLineId: RECEIPT_LINE_ID,
    linkedQuantity: d('30.000'),
    status: 'ACTIVE',
    createdBy: makeActor(),
    createdAt: NOW,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    ...overrides,
  };
}

function makeShipmentLineLockRow(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id: SHIPMENT_LINE_ID,
    plannedQuantity: d('100.000'),
    productId: null,
    purchaseInvoiceLineId: null,
    shipmentStatus: 'ARRIVED',
    ...overrides,
  };
}

function makeReceiptLineLockRow(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id: RECEIPT_LINE_ID,
    quantity: d('100.000'),
    purchaseInvoiceLineId: null,
    productId: null,
    receiptStatus: PurchaseReceiptStatus.ACTIVE,
    ...overrides,
  };
}

function createTxMock() {
  return {
    importReceiptLink: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
      findFirst: jest.fn<Promise<unknown>, [unknown]>(),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      create: jest.fn<Promise<unknown>, [unknown]>(),
      update: jest.fn<Promise<unknown>, [unknown]>(),
    },
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    importShipmentLine: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    importReceiptLink: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    importExpenseAllocation: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
}

function createSettingsReaderMock(currencyCode = 'PEN') {
  return { getCurrent: jest.fn().mockResolvedValue({ currencyCode }) };
}

describe('ImportReceiptLinksService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let settingsReader: ReturnType<typeof createSettingsReaderMock>;
  let service: ImportReceiptLinksService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    settingsReader = createSettingsReaderMock();
    service = new ImportReceiptLinksService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
      settingsReader as unknown as SettingsReader,
    );
  });

  function queueLockRows(
    shipmentLine: Record<string, unknown>,
    receiptLine: Record<string, unknown>,
  ): void {
    prisma.tx.$queryRaw
      .mockResolvedValueOnce([shipmentLine])
      .mockResolvedValueOnce([receiptLine]);
  }

  function createInput(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      importShipmentLineId: SHIPMENT_LINE_ID,
      purchaseReceiptLineId: RECEIPT_LINE_ID,
      linkedQuantity: '30.000',
      actorUserId: ACTOR_ID,
      ipAddress: null,
      ...overrides,
    };
  }

  describe('create', () => {
    it('crea un vínculo ACTIVE cuando embarque ARRIVED y recepción ACTIVE', async () => {
      queueLockRows(makeShipmentLineLockRow(), makeReceiptLineLockRow());
      prisma.tx.importReceiptLink.findFirst.mockResolvedValue(null);
      prisma.tx.importReceiptLink.findMany.mockResolvedValue([]);
      prisma.tx.importReceiptLink.create.mockResolvedValue(makeLinkRow());

      const result = await service.create(createInput());

      expect(result.id).toBe(LINK_ID);
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });

    it('linkedQuantity inválida (cero): BadRequestException, nunca abre transacción de lock', async () => {
      await expect(
        service.create(createInput({ linkedQuantity: '0' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('línea de embarque inexistente: NotFoundException', async () => {
      prisma.tx.$queryRaw.mockResolvedValueOnce([]);
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('embarque no ARRIVED: ConflictException', async () => {
      queueLockRows(
        makeShipmentLineLockRow({ shipmentStatus: 'IN_TRANSIT' }),
        makeReceiptLineLockRow(),
      );
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.tx.importReceiptLink.create).not.toHaveBeenCalled();
    });

    it('recepción no ACTIVE: ConflictException', async () => {
      queueLockRows(
        makeShipmentLineLockRow(),
        makeReceiptLineLockRow({
          receiptStatus: PurchaseReceiptStatus.CANCELLED,
        }),
      );
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('factura de compra distinta entre línea de embarque y recepción: BadRequestException', async () => {
      queueLockRows(
        makeShipmentLineLockRow({ purchaseInvoiceLineId: 'invoice-line-a' }),
        makeReceiptLineLockRow({ purchaseInvoiceLineId: 'invoice-line-b' }),
      );
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('producto distinto entre línea de embarque y recepción: BadRequestException', async () => {
      queueLockRows(
        makeShipmentLineLockRow({ productId: 'product-a' }),
        makeReceiptLineLockRow({ productId: 'product-b' }),
      );
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('vínculo ACTIVO duplicado entre la misma línea de embarque y recepción: ConflictException', async () => {
      queueLockRows(makeShipmentLineLockRow(), makeReceiptLineLockRow());
      prisma.tx.importReceiptLink.findFirst.mockResolvedValue({
        id: 'existing-link',
      });
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.tx.importReceiptLink.create).not.toHaveBeenCalled();
    });

    it('excede la cantidad embarcada de la línea: ConflictException', async () => {
      queueLockRows(
        makeShipmentLineLockRow({ plannedQuantity: d('40.000') }),
        makeReceiptLineLockRow({ quantity: d('100.000') }),
      );
      prisma.tx.importReceiptLink.findFirst.mockResolvedValue(null);
      // Ya hay 20 vinculados a la línea de embarque; +30 nuevos = 50 > 40 embarcados.
      prisma.tx.importReceiptLink.findMany.mockResolvedValueOnce([
        { linkedQuantity: d('20.000') },
      ]);
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.tx.importReceiptLink.create).not.toHaveBeenCalled();
    });

    it('excede la cantidad físicamente recibida de la línea de recepción: ConflictException', async () => {
      queueLockRows(
        makeShipmentLineLockRow({ plannedQuantity: d('100.000') }),
        makeReceiptLineLockRow({ quantity: d('40.000') }),
      );
      prisma.tx.importReceiptLink.findFirst.mockResolvedValue(null);
      prisma.tx.importReceiptLink.findMany
        .mockResolvedValueOnce([]) // suma contra la línea de embarque
        .mockResolvedValueOnce([{ linkedQuantity: d('20.000') }]); // suma contra la línea de recepción: 20+30=50 > 40
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.tx.importReceiptLink.create).not.toHaveBeenCalled();
    });

    it('idempotencyKey repetida: devuelve el mismo vínculo, nunca crea otro', async () => {
      queueLockRows(makeShipmentLineLockRow(), makeReceiptLineLockRow());
      prisma.tx.importReceiptLink.findUnique.mockResolvedValue(
        makeLinkRow({ id: 'already-created' }),
      );
      const result = await service.create(
        createInput({ idempotencyKey: 'retry-1' }),
      );
      expect(result.id).toBe('already-created');
      expect(prisma.tx.importReceiptLink.create).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });

  describe('listByShipmentLine', () => {
    it('rol sin permiso: ForbiddenException', async () => {
      await expect(
        service.listByShipmentLine(SHIPMENT_LINE_ID, RoleName.SELLER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('línea inexistente: NotFoundException', async () => {
      prisma.importShipmentLine.findUnique.mockResolvedValue(null);
      await expect(
        service.listByShipmentLine(SHIPMENT_LINE_ID, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('PENDING cuando no hay vínculos ACTIVE', async () => {
      prisma.importShipmentLine.findUnique.mockResolvedValue({
        id: SHIPMENT_LINE_ID,
        plannedQuantity: d('100.000'),
      });
      prisma.importReceiptLink.findMany.mockResolvedValue([]);
      const result = await service.listByShipmentLine(
        SHIPMENT_LINE_ID,
        RoleName.MANAGEMENT,
      );
      expect(result.receptionStatus).toBe('PENDING');
      expect(result.remainingQuantity).toBe('100.000');
    });

    it('PARTIALLY_RECEIVED con vínculos ACTIVE por debajo de lo embarcado; ignora CANCELLED', async () => {
      prisma.importShipmentLine.findUnique.mockResolvedValue({
        id: SHIPMENT_LINE_ID,
        plannedQuantity: d('100.000'),
      });
      prisma.importReceiptLink.findMany.mockResolvedValue([
        makeLinkRow({
          id: 'l1',
          linkedQuantity: d('30.000'),
          status: 'ACTIVE',
        }),
        makeLinkRow({
          id: 'l2',
          linkedQuantity: d('999.000'),
          status: 'CANCELLED',
        }),
      ]);
      const result = await service.listByShipmentLine(
        SHIPMENT_LINE_ID,
        RoleName.ACCOUNTANT,
      );
      expect(result.receptionStatus).toBe('PARTIALLY_RECEIVED');
      expect(result.linkedReceivedQuantity).toBe('30.000');
      expect(result.remainingQuantity).toBe('70.000');
    });

    it('FULLY_RECEIVED cuando lo vinculado ACTIVE iguala lo embarcado', async () => {
      prisma.importShipmentLine.findUnique.mockResolvedValue({
        id: SHIPMENT_LINE_ID,
        plannedQuantity: d('100.000'),
      });
      prisma.importReceiptLink.findMany.mockResolvedValue([
        makeLinkRow({
          id: 'l1',
          linkedQuantity: d('60.000'),
          status: 'ACTIVE',
        }),
        makeLinkRow({
          id: 'l2',
          linkedQuantity: d('40.000'),
          status: 'ACTIVE',
        }),
      ]);
      const result = await service.listByShipmentLine(
        SHIPMENT_LINE_ID,
        RoleName.ADMIN,
      );
      expect(result.receptionStatus).toBe('FULLY_RECEIVED');
      expect(result.remainingQuantity).toBe('0.000');
    });
  });

  describe('cancel', () => {
    it('cancela correctamente un vínculo ACTIVE', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        { id: LINK_ID, status: 'ACTIVE' },
      ]);
      prisma.tx.importReceiptLink.update.mockResolvedValue(
        makeLinkRow({ status: 'CANCELLED', cancellationReason: 'motivo' }),
      );
      const result = await service.cancel({
        importReceiptLinkId: LINK_ID,
        reason: 'motivo',
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(result.status).toBe('CANCELLED');
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });

    it('vínculo inexistente: NotFoundException', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([]);
      await expect(
        service.cancel({
          importReceiptLinkId: LINK_ID,
          reason: 'motivo',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('vínculo ya CANCELLED: ConflictException', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        { id: LINK_ID, status: 'CANCELLED' },
      ]);
      await expect(
        service.cancel({
          importReceiptLinkId: LINK_ID,
          reason: 'motivo',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.importReceiptLink.update).not.toHaveBeenCalled();
    });

    it('reason vacío: BadRequestException, nunca abre transacción de lock', async () => {
      await expect(
        service.cancel({
          importReceiptLinkId: LINK_ID,
          reason: '   ',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('previewCostAttribution', () => {
    const ALLOCATION_ID = 'allocation-1';

    function makeAllocation(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: ALLOCATION_ID,
        importShipmentLineId: SHIPMENT_LINE_ID,
        amount: d('400.00'),
        importShipmentLine: { plannedQuantity: d('100.000') },
        batch: { importExpense: { currencyCode: 'PEN' } },
        ...overrides,
      };
    }

    it('rol sin permiso: ForbiddenException', async () => {
      await expect(
        service.previewCostAttribution(ALLOCATION_ID, RoleName.WAREHOUSE),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('asignación inexistente: NotFoundException', async () => {
      prisma.importExpenseAllocation.findUnique.mockResolvedValue(null);
      await expect(
        service.previewCostAttribution(ALLOCATION_ID, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sin vínculos ACTIVE: lines vacío, todo el monto queda unattributedAmount', async () => {
      prisma.importExpenseAllocation.findUnique.mockResolvedValue(
        makeAllocation(),
      );
      prisma.importReceiptLink.findMany.mockResolvedValue([]);
      const result = await service.previewCostAttribution(
        ALLOCATION_ID,
        RoleName.ADMIN,
      );
      expect(result.lines).toHaveLength(0);
      expect(result.unattributedAmount).toBe('400.00');
    });

    it('reparte proporcionalmente por cantidad vinculada ACTIVE (reutiliza el cálculo de B2); recepción COMPLETA: suma exacta, unattributedAmount en 0.00', async () => {
      prisma.importExpenseAllocation.findUnique.mockResolvedValue(
        makeAllocation({ amount: d('400.00') }),
      );
      prisma.importReceiptLink.findMany.mockResolvedValue([
        {
          id: 'link-a',
          purchaseReceiptLineId: 'receipt-line-a',
          linkedQuantity: d('30.000'),
        },
        {
          id: 'link-b',
          purchaseReceiptLineId: 'receipt-line-b',
          linkedQuantity: d('70.000'),
        },
      ]);
      const result = await service.previewCostAttribution(
        ALLOCATION_ID,
        RoleName.ADMIN,
      );
      expect(result.lines).toHaveLength(2);
      const sum = result.lines.reduce(
        (s, l) => s.plus(new Prisma.Decimal(l.attributedAmount)),
        new Prisma.Decimal(0),
      );
      expect(sum.toFixed(2)).toBe('400.00');
      expect(result.unattributedAmount).toBe('0.00');
    });

    it('recepción PARCIAL (CLAUDE.md B3 §4): nunca atribuye el gasto completo a las primeras unidades recibidas', async () => {
      // 100 unidades embarcadas, 100.00 PEN asignados, solo 30 recibidas
      // (vínculo ACTIVE) — las 70 restantes todavía SIN vínculo.
      prisma.importExpenseAllocation.findUnique.mockResolvedValue(
        makeAllocation({
          amount: d('100.00'),
          importShipmentLine: { plannedQuantity: d('100.000') },
        }),
      );
      prisma.importReceiptLink.findMany.mockResolvedValue([
        {
          id: 'link-a',
          purchaseReceiptLineId: 'receipt-line-a',
          linkedQuantity: d('30.000'),
        },
      ]);
      const result = await service.previewCostAttribution(
        ALLOCATION_ID,
        RoleName.ADMIN,
      );
      expect(result.allocatedAmount).toBe('100.00');
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].attributedAmount).toBe('30.00');
      expect(result.unattributedAmount).toBe('70.00');
    });

    it('cantidades CANCELLED nunca participan en la atribución activa', async () => {
      prisma.importExpenseAllocation.findUnique.mockResolvedValue(
        makeAllocation({
          amount: d('100.00'),
          importShipmentLine: { plannedQuantity: d('100.000') },
        }),
      );
      // findMany ya filtra status: 'ACTIVE' en el where (verificado abajo);
      // el mock solo devuelve lo que el servicio pide.
      prisma.importReceiptLink.findMany.mockResolvedValue([
        {
          id: 'link-a',
          purchaseReceiptLineId: 'receipt-line-a',
          linkedQuantity: d('30.000'),
        },
      ]);
      await service.previewCostAttribution(ALLOCATION_ID, RoleName.ADMIN);
      const call = prisma.importReceiptLink.findMany.mock.calls[0][0] as {
        where: { status: string };
      };
      expect(call.where.status).toBe('ACTIVE');
    });

    it('moneda del gasto distinta de la moneda de la empresa: financialStatus PENDING_FX', async () => {
      prisma.importExpenseAllocation.findUnique.mockResolvedValue(
        makeAllocation({ batch: { importExpense: { currencyCode: 'USD' } } }),
      );
      prisma.importReceiptLink.findMany.mockResolvedValue([]);
      settingsReader.getCurrent.mockResolvedValue({ currencyCode: 'PEN' });
      const result = await service.previewCostAttribution(
        ALLOCATION_ID,
        RoleName.ADMIN,
      );
      expect(result.financialStatus).toBe('PENDING_FX');
    });

    it('moneda del gasto igual a la moneda de la empresa: financialStatus PENDING_ACCOUNTING_POLICY', async () => {
      prisma.importExpenseAllocation.findUnique.mockResolvedValue(
        makeAllocation({ batch: { importExpense: { currencyCode: 'PEN' } } }),
      );
      prisma.importReceiptLink.findMany.mockResolvedValue([]);
      settingsReader.getCurrent.mockResolvedValue({ currencyCode: 'PEN' });
      const result = await service.previewCostAttribution(
        ALLOCATION_ID,
        RoleName.ADMIN,
      );
      expect(result.financialStatus).toBe('PENDING_ACCOUNTING_POLICY');
    });

    it('nunca persiste ni audita (es pura)', async () => {
      prisma.importExpenseAllocation.findUnique.mockResolvedValue(
        makeAllocation(),
      );
      prisma.importReceiptLink.findMany.mockResolvedValue([]);
      await service.previewCostAttribution(ALLOCATION_ID, RoleName.ADMIN);
      expect(auditService.record).not.toHaveBeenCalled();
      expect(prisma.tx.importReceiptLink.create).not.toHaveBeenCalled();
    });
  });
});
