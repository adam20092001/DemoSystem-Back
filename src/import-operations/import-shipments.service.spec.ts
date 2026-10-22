import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ImportOperationStatus,
  ImportShipmentStatus,
  ImportTransportMode,
  Prisma,
  RoleName,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ImportShipmentsService } from './import-shipments.service';

const ACTOR_ID = 'actor-id';
const OPERATION_ID = 'operation-1';
const SHIPMENT_ID = 'shipment-1';
const INVOICE_LINE_ID = 'invoice-line-1';
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

function makeLineRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'line-1',
    productId: null,
    descriptionSnapshot: 'Repuesto genérico',
    plannedQuantity: d('10.000'),
    unitCode: null,
    unitName: null,
    weightValue: null,
    weightUnit: null,
    volumeValue: null,
    volumeUnit: null,
    purchaseInvoiceLineId: null,
    ...overrides,
  };
}

function makeShipmentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SHIPMENT_ID,
    importOperationId: OPERATION_ID,
    transportMode: ImportTransportMode.SEA,
    carrierName: null,
    trackingReference: null,
    billOfLadingNumber: null,
    containerReference: null,
    originLocation: null,
    destinationLocation: null,
    estimatedDepartureDate: null,
    actualDepartureDate: null,
    estimatedArrivalDate: null,
    actualArrivalDate: null,
    status: ImportShipmentStatus.PLANNED,
    notes: null,
    createdBy: makeActor(),
    createdAt: NOW,
    updatedAt: NOW,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    lines: [],
    ...overrides,
  };
}

function createTxMock() {
  return {
    importOperation: {
      update: jest.fn<Promise<unknown>, [unknown]>(),
    },
    importShipment: {
      create: jest.fn<Promise<unknown>, [unknown]>(),
      update: jest.fn<Promise<unknown>, [unknown]>(),
      findUniqueOrThrow: jest.fn<Promise<unknown>, [unknown]>(),
    },
    importShipmentLine: {
      deleteMany: jest.fn<Promise<unknown>, [unknown]>(),
      createMany: jest.fn<Promise<unknown>, [unknown]>(),
      groupBy: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    product: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    importOperation: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    importShipment: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
}

describe('ImportShipmentsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: ImportShipmentsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    // Lock de ImportOperation por defecto: DRAFT (primer embarque).
    prisma.tx.$queryRaw.mockResolvedValue([
      { id: OPERATION_ID, status: ImportOperationStatus.DRAFT },
    ]);
    prisma.tx.importShipmentLine.groupBy.mockResolvedValue([]);
    prisma.tx.product.findMany.mockResolvedValue([]);
    service = new ImportShipmentsService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  function basicLine(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      descriptionSnapshot: 'Repuesto genérico',
      plannedQuantity: '10.000',
      ...overrides,
    };
  }

  describe('create', () => {
    it('crea el embarque y transiciona la operación DRAFT->IN_PROGRESS', async () => {
      prisma.tx.importShipment.create.mockResolvedValue(
        makeShipmentRow({ lines: [makeLineRow()] }),
      );

      await service.create({
        importOperationId: OPERATION_ID,
        transportMode: ImportTransportMode.SEA,
        lines: [basicLine()],
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });

      expect(prisma.tx.importOperation.update).toHaveBeenCalledWith({
        where: { id: OPERATION_ID },
        data: { status: ImportOperationStatus.IN_PROGRESS },
      });
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });

    it('operación IN_PROGRESS: NO vuelve a transicionar (idempotente)', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        { id: OPERATION_ID, status: ImportOperationStatus.IN_PROGRESS },
      ]);
      prisma.tx.importShipment.create.mockResolvedValue(makeShipmentRow());

      await service.create({
        importOperationId: OPERATION_ID,
        transportMode: ImportTransportMode.SEA,
        lines: [basicLine()],
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });

      expect(prisma.tx.importOperation.update).not.toHaveBeenCalled();
    });

    it('operación COMPLETED: ConflictException, nunca crea el embarque', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        { id: OPERATION_ID, status: ImportOperationStatus.COMPLETED },
      ]);
      await expect(
        service.create({
          importOperationId: OPERATION_ID,
          transportMode: ImportTransportMode.SEA,
          lines: [basicLine()],
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.importShipment.create).not.toHaveBeenCalled();
    });

    it('sin líneas: BadRequestException', async () => {
      await expect(
        service.create({
          importOperationId: OPERATION_ID,
          transportMode: ImportTransportMode.SEA,
          lines: [],
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('línea sin productId ni descriptionSnapshot: BadRequestException', async () => {
      await expect(
        service.create({
          importOperationId: OPERATION_ID,
          transportMode: ImportTransportMode.SEA,
          lines: [{ plannedQuantity: '1.000' }],
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('plannedQuantity <= 0: BadRequestException', async () => {
      await expect(
        service.create({
          importOperationId: OPERATION_ID,
          transportMode: ImportTransportMode.SEA,
          lines: [basicLine({ plannedQuantity: '0' })],
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    describe('vínculo opcional a PurchaseInvoiceLine (protección de sobre-asignación)', () => {
      function queueInvoiceLineLock(
        quantity: string,
        invoiceStatus = 'CONFIRMED',
        productId: string | null = null,
      ): void {
        prisma.tx.$queryRaw
          .mockResolvedValueOnce([
            { id: OPERATION_ID, status: ImportOperationStatus.DRAFT },
          ])
          .mockResolvedValueOnce([
            {
              id: INVOICE_LINE_ID,
              quantity: d(quantity),
              productId,
              invoiceStatus,
            },
          ]);
      }

      it('línea de factura no CONFIRMED: ConflictException', async () => {
        queueInvoiceLineLock('100.000', 'DRAFT');
        await expect(
          service.create({
            importOperationId: OPERATION_ID,
            transportMode: ImportTransportMode.SEA,
            lines: [
              basicLine({
                plannedQuantity: '10.000',
                purchaseInvoiceLineId: INVOICE_LINE_ID,
              }),
            ],
            actorUserId: ACTOR_ID,
            ipAddress: null,
          }),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('cantidad planificada dentro de lo facturado (sin asignación previa): crea correctamente', async () => {
        queueInvoiceLineLock('100.000');
        prisma.tx.importShipmentLine.groupBy.mockResolvedValue([]);
        prisma.tx.importShipment.create.mockResolvedValue(makeShipmentRow());

        await expect(
          service.create({
            importOperationId: OPERATION_ID,
            transportMode: ImportTransportMode.SEA,
            lines: [
              basicLine({
                plannedQuantity: '40.000',
                purchaseInvoiceLineId: INVOICE_LINE_ID,
              }),
            ],
            actorUserId: ACTOR_ID,
            ipAddress: null,
          }),
        ).resolves.toBeDefined();
      });

      it('cantidad planificada + ya asignado (otros embarques no CANCELLED) excede lo facturado: ConflictException', async () => {
        queueInvoiceLineLock('100.000');
        prisma.tx.importShipmentLine.groupBy.mockResolvedValue([
          {
            purchaseInvoiceLineId: INVOICE_LINE_ID,
            _sum: { plannedQuantity: d('70.000') },
          },
        ]);
        await expect(
          service.create({
            importOperationId: OPERATION_ID,
            transportMode: ImportTransportMode.SEA,
            lines: [
              basicLine({
                plannedQuantity: '40.000',
                purchaseInvoiceLineId: INVOICE_LINE_ID,
              }),
            ],
            actorUserId: ACTOR_ID,
            ipAddress: null,
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.tx.importShipment.create).not.toHaveBeenCalled();
      });

      it('varias líneas del MISMO embarque referenciando la MISMA línea de factura se suman entre sí', async () => {
        queueInvoiceLineLock('100.000');
        prisma.tx.importShipmentLine.groupBy.mockResolvedValue([]);
        await expect(
          service.create({
            importOperationId: OPERATION_ID,
            transportMode: ImportTransportMode.SEA,
            lines: [
              basicLine({
                plannedQuantity: '60.000',
                purchaseInvoiceLineId: INVOICE_LINE_ID,
              }),
              basicLine({
                plannedQuantity: '60.000',
                purchaseInvoiceLineId: INVOICE_LINE_ID,
              }),
            ],
            actorUserId: ACTOR_ID,
            ipAddress: null,
          }),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('producto de la línea no coincide con el de la factura referenciada: BadRequestException', async () => {
        queueInvoiceLineLock('100.000', 'CONFIRMED', 'product-A');
        await expect(
          service.create({
            importOperationId: OPERATION_ID,
            transportMode: ImportTransportMode.SEA,
            lines: [
              basicLine({
                plannedQuantity: '10.000',
                productId: 'product-B',
                purchaseInvoiceLineId: INVOICE_LINE_ID,
              }),
            ],
            actorUserId: ACTOR_ID,
            ipAddress: null,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });
  });

  describe('permisos de lectura', () => {
    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s no puede leer',
      async (role) => {
        await expect(service.findOne(SHIPMENT_ID, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      },
    );
  });

  describe('update', () => {
    it('embarque no PLANNED: ConflictException', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        {
          id: SHIPMENT_ID,
          importOperationId: OPERATION_ID,
          status: ImportShipmentStatus.IN_TRANSIT,
        },
      ]);
      await expect(
        service.update({
          importShipmentId: SHIPMENT_ID,
          notes: 'actualizado',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('PLANNED: reemplaza el arreglo de líneas completo', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        {
          id: SHIPMENT_ID,
          importOperationId: OPERATION_ID,
          status: ImportShipmentStatus.PLANNED,
        },
      ]);
      prisma.tx.importShipment.findUniqueOrThrow.mockResolvedValue(
        makeShipmentRow({ lines: [makeLineRow({ id: 'line-new' })] }),
      );

      await service.update({
        importShipmentId: SHIPMENT_ID,
        lines: [basicLine({ plannedQuantity: '5.000' })],
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });

      expect(prisma.tx.importShipmentLine.deleteMany).toHaveBeenCalledWith({
        where: { importShipmentId: SHIPMENT_ID },
      });
      expect(prisma.tx.importShipmentLine.createMany).toHaveBeenCalledTimes(1);
    });

    it('sin ningún campo: BadRequestException', async () => {
      await expect(
        service.update({
          importShipmentId: SHIPMENT_ID,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('depart', () => {
    it('PLANNED -> IN_TRANSIT', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        {
          id: SHIPMENT_ID,
          importOperationId: OPERATION_ID,
          status: ImportShipmentStatus.PLANNED,
        },
      ]);
      prisma.tx.importShipment.update.mockResolvedValue(
        makeShipmentRow({ status: ImportShipmentStatus.IN_TRANSIT }),
      );
      const result = await service.depart({
        importShipmentId: SHIPMENT_ID,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(result.status).toBe(ImportShipmentStatus.IN_TRANSIT);
    });

    it('no PLANNED: ConflictException', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        {
          id: SHIPMENT_ID,
          importOperationId: OPERATION_ID,
          status: ImportShipmentStatus.ARRIVED,
        },
      ]);
      await expect(
        service.depart({
          importShipmentId: SHIPMENT_ID,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('arrive', () => {
    it.each([ImportShipmentStatus.PLANNED, ImportShipmentStatus.IN_TRANSIT])(
      '%s -> ARRIVED (nunca mueve stock: sin StockMovementEngine inyectado)',
      async (fromStatus) => {
        prisma.tx.$queryRaw.mockResolvedValue([
          {
            id: SHIPMENT_ID,
            importOperationId: OPERATION_ID,
            status: fromStatus,
          },
        ]);
        prisma.tx.importShipment.update.mockResolvedValue(
          makeShipmentRow({ status: ImportShipmentStatus.ARRIVED }),
        );
        const result = await service.arrive({
          importShipmentId: SHIPMENT_ID,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        });
        expect(result.status).toBe(ImportShipmentStatus.ARRIVED);
      },
    );

    it('CANCELLED: ConflictException', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        {
          id: SHIPMENT_ID,
          importOperationId: OPERATION_ID,
          status: ImportShipmentStatus.CANCELLED,
        },
      ]);
      await expect(
        service.arrive({
          importShipmentId: SHIPMENT_ID,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('cancel', () => {
    it('ARRIVED: ConflictException (terminal, nunca se anula)', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        {
          id: SHIPMENT_ID,
          importOperationId: OPERATION_ID,
          status: ImportShipmentStatus.ARRIVED,
        },
      ]);
      await expect(
        service.cancel({
          importShipmentId: SHIPMENT_ID,
          reason: 'motivo',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('PLANNED: anula correctamente', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        {
          id: SHIPMENT_ID,
          importOperationId: OPERATION_ID,
          status: ImportShipmentStatus.PLANNED,
        },
      ]);
      prisma.tx.importShipment.update.mockResolvedValue(
        makeShipmentRow({
          status: ImportShipmentStatus.CANCELLED,
          cancelledAt: NOW,
          cancelledBy: makeActor(),
          cancellationReason: 'motivo de prueba',
        }),
      );
      const result = await service.cancel({
        importShipmentId: SHIPMENT_ID,
        reason: 'motivo de prueba',
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(result.status).toBe(ImportShipmentStatus.CANCELLED);
    });
  });

  describe('findOne', () => {
    it('inexistente: NotFoundException', async () => {
      prisma.importShipment.findUnique.mockResolvedValue(null);
      await expect(
        service.findOne(SHIPMENT_ID, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
