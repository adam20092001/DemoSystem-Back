import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ImportOperationStatus, RoleName } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ImportOperationsService } from './import-operations.service';

const ACTOR_ID = 'actor-id';
const OPERATION_ID = 'operation-1';
const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeActor() {
  return {
    id: ACTOR_ID,
    username: 'admin',
    firstName: 'Ana',
    lastName: 'Admin',
  };
}

function makeOperationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: OPERATION_ID,
    reference: 'IMP-2026-0001',
    description: null,
    originCountry: 'CN',
    destinationCountry: 'PE',
    status: ImportOperationStatus.DRAFT,
    externalReference: null,
    notes: null,
    purchaseInvoiceId: null,
    isLegacyUnlinked: true,
    purchaseInvoice: null,
    createdBy: makeActor(),
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    completedBy: null,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    _count: { shipments: 0 },
    ...overrides,
  };
}

function createTxMock() {
  return {
    importOperation: {
      create: jest.fn<Promise<unknown>, [unknown]>(),
      update: jest.fn<Promise<unknown>, [unknown]>(),
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    importShipment: {
      findFirst: jest.fn<Promise<unknown>, [unknown]>(),
    },
    // R4: catálogo de países (existente y activo).
    country: {
      findUnique: jest.fn().mockResolvedValue({ active: true }),
    },
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    importOperation: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
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

describe('ImportOperationsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: ImportOperationsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    prisma.tx.$queryRaw.mockResolvedValue([
      { id: OPERATION_ID, status: ImportOperationStatus.IN_PROGRESS },
    ]);
    prisma.tx.importShipment.findFirst.mockResolvedValue(null);
    service = new ImportOperationsService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  describe('create', () => {
    const INVOICE_ID = '11111111-1111-4111-8111-111111111111';

    /** Primera llamada: lock de la factura; segunda: correlativo anual. */
    function mockInvoiceAndSequence(
      status: string = 'DRAFT',
      sequence = 1,
    ): void {
      prisma.tx.$queryRaw.mockReset();
      prisma.tx.$queryRaw
        .mockResolvedValueOnce([{ id: INVOICE_ID, status }])
        .mockResolvedValueOnce([{ lastNumber: sequence }]);
    }

    it('crea una operación DRAFT vinculada a la factura, con referencia generada IMP-AAAA-NNNNNN', async () => {
      mockInvoiceAndSequence('DRAFT', 7);
      prisma.tx.importOperation.create.mockResolvedValue(makeOperationRow());

      const result = await service.create({
        purchaseInvoiceId: INVOICE_ID,
        originCountry: 'cn',
        destinationCountry: 'pe',
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });

      expect(result.id).toBe(OPERATION_ID);
      const call = prisma.tx.importOperation.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.reference).toMatch(/^IMP-\d{4}-000007$/);
      expect(call.data.purchaseInvoiceId).toBe(INVOICE_ID);
      expect(call.data.isLegacyUnlinked).toBe(false);
      expect(call.data.originCountry).toBe('CN');
      expect(call.data.destinationCountry).toBe('PE');
      expect(call.data.status).toBe(ImportOperationStatus.DRAFT);
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });

    it('admite una factura CONFIRMED', async () => {
      mockInvoiceAndSequence('CONFIRMED');
      prisma.tx.importOperation.create.mockResolvedValue(makeOperationRow());
      await expect(
        service.create({
          purchaseInvoiceId: INVOICE_ID,
          originCountry: 'CN',
          destinationCountry: 'PE',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).resolves.toBeDefined();
    });

    it('factura inexistente: 400 (campo purchaseInvoiceId) y nunca crea ni consume correlativo', async () => {
      prisma.tx.$queryRaw.mockReset();
      prisma.tx.$queryRaw.mockResolvedValueOnce([]);
      await expect(
        service.create({
          purchaseInvoiceId: INVOICE_ID,
          originCountry: 'CN',
          destinationCountry: 'PE',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.importOperation.create).not.toHaveBeenCalled();
      expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('factura anulada: 409 y nunca crea', async () => {
      mockInvoiceAndSequence('CANCELLED');
      await expect(
        service.create({
          purchaseInvoiceId: INVOICE_ID,
          originCountry: 'CN',
          destinationCountry: 'PE',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.importOperation.create).not.toHaveBeenCalled();
    });

    it('país inexistente en el catálogo: 400 y nunca crea', async () => {
      prisma.tx.country.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.create({
          purchaseInvoiceId: INVOICE_ID,
          originCountry: 'ZZ',
          destinationCountry: 'PE',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.importOperation.create).not.toHaveBeenCalled();
    });

    it('país inactivo: 409 y nunca crea', async () => {
      prisma.tx.country.findUnique.mockResolvedValueOnce({ active: false });
      await expect(
        service.create({
          purchaseInvoiceId: INVOICE_ID,
          originCountry: 'CN',
          destinationCountry: 'PE',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('originCountry/destinationCountry con formato inválido: BadRequestException', async () => {
      await expect(
        service.create({
          purchaseInvoiceId: INVOICE_ID,
          originCountry: 'CHN',
          destinationCountry: 'PE',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.importOperation.create).not.toHaveBeenCalled();
    });
  });

  describe('permisos de lectura', () => {
    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s no puede leer',
      async (role) => {
        await expect(
          service.findOne(OPERATION_ID, role),
        ).rejects.toBeInstanceOf(ForbiddenException);
        const result = await service.list({}, role);
        expect(result.data).toEqual([]);
        expect(result.total).toBe(0);
      },
    );

    it.each([RoleName.ADMIN, RoleName.MANAGEMENT, RoleName.ACCOUNTANT])(
      '%s puede leer',
      async (role) => {
        prisma.importOperation.findUnique.mockResolvedValue(makeOperationRow());
        await expect(
          service.findOne(OPERATION_ID, role),
        ).resolves.toBeDefined();
      },
    );
  });

  describe('findOne', () => {
    it('operación inexistente: NotFoundException', async () => {
      prisma.importOperation.findUnique.mockResolvedValue(null);
      await expect(
        service.findOne(OPERATION_ID, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('sin ningún campo: BadRequestException', async () => {
      await expect(
        service.update({
          importOperationId: OPERATION_ID,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('operación COMPLETED: ConflictException, nunca edita', async () => {
      prisma.tx.importOperation.findUnique.mockResolvedValue({
        id: OPERATION_ID,
        status: ImportOperationStatus.COMPLETED,
      });
      await expect(
        service.update({
          importOperationId: OPERATION_ID,
          notes: 'nueva nota',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.importOperation.update).not.toHaveBeenCalled();
    });

    it('operación DRAFT: edita los campos provistos', async () => {
      prisma.tx.importOperation.findUnique.mockResolvedValue({
        id: OPERATION_ID,
        status: ImportOperationStatus.DRAFT,
      });
      prisma.tx.importOperation.update.mockResolvedValue(
        makeOperationRow({ notes: 'nueva nota' }),
      );
      const result = await service.update({
        importOperationId: OPERATION_ID,
        notes: 'nueva nota',
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(result.notes).toBe('nueva nota');
    });
  });

  describe('complete', () => {
    it('operación no IN_PROGRESS: ConflictException', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        { id: OPERATION_ID, status: ImportOperationStatus.DRAFT },
      ]);
      await expect(
        service.complete({
          importOperationId: OPERATION_ID,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('tiene un embarque PLANNED/IN_TRANSIT: ConflictException, nunca completa', async () => {
      prisma.tx.importShipment.findFirst.mockResolvedValue({
        id: 'shipment-1',
      });
      await expect(
        service.complete({
          importOperationId: OPERATION_ID,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.importOperation.update).not.toHaveBeenCalled();
    });

    it('IN_PROGRESS sin embarques pendientes: completa correctamente', async () => {
      prisma.tx.importOperation.update.mockResolvedValue(
        makeOperationRow({
          status: ImportOperationStatus.COMPLETED,
          completedAt: NOW,
          completedBy: makeActor(),
        }),
      );
      const result = await service.complete({
        importOperationId: OPERATION_ID,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(result.status).toBe(ImportOperationStatus.COMPLETED);
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancel', () => {
    it('tiene un embarque ARRIVED: ConflictException, nunca anula', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        { id: OPERATION_ID, status: ImportOperationStatus.IN_PROGRESS },
      ]);
      prisma.tx.importShipment.findFirst.mockResolvedValue({
        id: 'shipment-1',
      });
      await expect(
        service.cancel({
          importOperationId: OPERATION_ID,
          reason: 'motivo de prueba',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.importOperation.update).not.toHaveBeenCalled();
    });

    it('operación COMPLETED: ConflictException (solo DRAFT/IN_PROGRESS se anulan)', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        { id: OPERATION_ID, status: ImportOperationStatus.COMPLETED },
      ]);
      await expect(
        service.cancel({
          importOperationId: OPERATION_ID,
          reason: 'motivo',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('DRAFT sin embarques ARRIVED: anula correctamente', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        { id: OPERATION_ID, status: ImportOperationStatus.DRAFT },
      ]);
      prisma.tx.importOperation.update.mockResolvedValue(
        makeOperationRow({
          status: ImportOperationStatus.CANCELLED,
          cancelledAt: NOW,
          cancelledBy: makeActor(),
          cancellationReason: 'motivo de prueba',
        }),
      );
      const result = await service.cancel({
        importOperationId: OPERATION_ID,
        reason: 'motivo de prueba',
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(result.status).toBe(ImportOperationStatus.CANCELLED);
    });

    it('reason vacío: BadRequestException', async () => {
      await expect(
        service.cancel({
          importOperationId: OPERATION_ID,
          reason: '   ',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
