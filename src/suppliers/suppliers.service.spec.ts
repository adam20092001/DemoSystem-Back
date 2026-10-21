import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RoleName, SupplierDocumentType, SupplierStatus } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { SuppliersService } from './suppliers.service';

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

interface SupplierCreateArgs {
  data: Record<string, unknown>;
}
interface SupplierUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}
interface SupplierFindUniqueArgs {
  where: { id: string };
  select?: Record<string, unknown>;
}
interface SupplierFindManyArgs {
  where?: Record<string, unknown>;
  select?: Record<string, unknown>;
  orderBy?: unknown;
  skip?: number;
  take?: number;
}
interface SupplierCountArgs {
  where?: Record<string, unknown>;
}

function makeSupplierRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'supplier-1',
    documentType: SupplierDocumentType.RUC,
    documentNumber: '20123456789',
    countryCode: 'PE',
    legalName: 'Importaciones Acme S.A.C.',
    tradeName: null,
    contactName: null,
    phone: null,
    email: null,
    address: null,
    internalNotes: null,
    defaultCurrencyCode: null,
    status: SupplierStatus.ACTIVE,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    supplier: {
      create: jest.fn<Promise<unknown>, [SupplierCreateArgs]>(),
      findUnique: jest.fn<Promise<unknown>, [SupplierFindUniqueArgs]>(),
      update: jest.fn<Promise<unknown>, [SupplierUpdateArgs]>(),
    },
  };

  return {
    tx,
    supplier: {
      findUnique: jest.fn<Promise<unknown>, [SupplierFindUniqueArgs]>(),
      findMany: jest.fn<Promise<unknown[]>, [SupplierFindManyArgs]>(),
      count: jest.fn<Promise<number>, [SupplierCountArgs?]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
}

function makeCreateInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    documentType: SupplierDocumentType.RUC,
    documentNumber: '20123456789',
    legalName: 'Importaciones Acme S.A.C.',
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
    ...overrides,
  };
}

describe('SuppliersService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: SuppliersService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    service = new SuppliersService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );

    prisma.tx.supplier.create.mockResolvedValue(makeSupplierRow());
    prisma.tx.supplier.findUnique.mockResolvedValue(makeSupplierRow());
    prisma.tx.supplier.update.mockResolvedValue(makeSupplierRow());
    prisma.supplier.findUnique.mockResolvedValue(makeSupplierRow());
    prisma.supplier.findMany.mockResolvedValue([makeSupplierRow()]);
    prisma.supplier.count.mockResolvedValue(1);
  });

  // ====================================================================
  // create
  // ====================================================================
  describe('create', () => {
    it('crea un proveedor ACTIVE con countryCode "PE" por defecto', async () => {
      await service.create(makeCreateInput());
      const call = prisma.tx.supplier.create.mock.calls[0][0] as {
        data: { status: SupplierStatus; countryCode: string };
      };
      expect(call.data.status).toBe(SupplierStatus.ACTIVE);
      expect(call.data.countryCode).toBe('PE');
    });

    it('normaliza documentNumber a mayúsculas sin espacios', async () => {
      await service.create(
        makeCreateInput({
          documentType: SupplierDocumentType.FOREIGN_TAX_ID,
          documentNumber: '  abc-99  ',
        }),
      );
      const call = prisma.tx.supplier.create.mock.calls[0][0] as {
        data: { documentNumber: string };
      };
      expect(call.data.documentNumber).toBe('ABC-99');
    });

    it('RUC con formato inválido: BadRequestException, nunca llega a Prisma', async () => {
      await expect(
        service.create(makeCreateInput({ documentNumber: '123' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.supplier.create).not.toHaveBeenCalled();
    });

    it('legalName vacío: BadRequestException', async () => {
      await expect(
        service.create(makeCreateInput({ legalName: '   ' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('countryCode inválido explícito: BadRequestException', async () => {
      await expect(
        service.create(makeCreateInput({ countryCode: 'PERU' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sin pre-check SELECT: create() nunca llama a findUnique antes del INSERT (la unicidad depende exclusivamente del índice de base de datos)', async () => {
      await service.create(makeCreateInput());
      expect(prisma.tx.supplier.findUnique).not.toHaveBeenCalled();
    });

    it('audita SUPPLIER_CREATED exactamente una vez, sin PII en metadata', async () => {
      await service.create(makeCreateInput());
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: Record<string, unknown>;
      };
      expect(call.action).toBe(AuditAction.SUPPLIER_CREATED);
      expect(call.metadata).toEqual({
        documentType: SupplierDocumentType.RUC,
        countryCode: 'PE',
      });
    });
  });

  // ====================================================================
  // Permisos de lectura
  // ====================================================================
  describe('permisos de lectura', () => {
    it.each([RoleName.ADMIN, RoleName.MANAGEMENT, RoleName.ACCOUNTANT])(
      '%s: puede listar y consultar',
      async (role) => {
        await expect(service.list({}, role)).resolves.toBeDefined();
        await expect(
          service.findOne('supplier-1', role),
        ).resolves.toBeDefined();
      },
    );

    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s: lista vacía sin tocar Prisma; findOne lanza ForbiddenException',
      async (role) => {
        const result = await service.list({}, role);
        expect(result).toEqual({
          data: [],
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        });
        expect(prisma.supplier.findMany).not.toHaveBeenCalled();

        await expect(
          service.findOne('supplier-1', role),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );
  });

  // ====================================================================
  // findOne
  // ====================================================================
  describe('findOne', () => {
    it('inexistente: NotFoundException', async () => {
      prisma.supplier.findUnique.mockResolvedValue(null);
      await expect(
        service.findOne('missing-id', RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ====================================================================
  // update
  // ====================================================================
  describe('update', () => {
    it('sin ningún campo: BadRequestException', async () => {
      await expect(
        service.update({ supplierId: 'supplier-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('documentType sin documentNumber (o viceversa): BadRequestException', async () => {
      await expect(
        service.update({
          supplierId: 'supplier-1',
          documentType: SupplierDocumentType.DNI,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('proveedor inexistente: NotFoundException', async () => {
      prisma.tx.supplier.findUnique.mockResolvedValue(null);
      await expect(
        service.update({
          supplierId: 'missing-id',
          legalName: 'Nuevo nombre',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reemplaza documentType+documentNumber juntos, validando el nuevo formato', async () => {
      await service.update({
        supplierId: 'supplier-1',
        documentType: SupplierDocumentType.DNI,
        documentNumber: '12345678',
        actorUserId: ACTOR_ID,
      });
      const call = prisma.tx.supplier.update.mock.calls[0][0] as unknown as {
        data: { documentType: SupplierDocumentType; documentNumber: string };
      };
      expect(call.data.documentType).toBe(SupplierDocumentType.DNI);
      expect(call.data.documentNumber).toBe('12345678');
    });

    it('audita SUPPLIER_UPDATED con updatedFields exactos', async () => {
      await service.update({
        supplierId: 'supplier-1',
        legalName: 'Nombre actualizado',
        phone: '999999999',
        actorUserId: ACTOR_ID,
      });
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: { updatedFields: string[] };
      };
      expect(call.action).toBe(AuditAction.SUPPLIER_UPDATED);
      expect(call.metadata.updatedFields).toEqual(['legalName', 'phone']);
    });
  });

  // ====================================================================
  // activate / deactivate
  // ====================================================================
  describe('activate/deactivate', () => {
    it('activate sobre un proveedor ya ACTIVE: ConflictException', async () => {
      prisma.tx.supplier.findUnique.mockResolvedValue(
        makeSupplierRow({ status: SupplierStatus.ACTIVE }),
      );
      await expect(
        service.activate({ supplierId: 'supplier-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('deactivate sobre un proveedor INACTIVE: ConflictException', async () => {
      prisma.tx.supplier.findUnique.mockResolvedValue(
        makeSupplierRow({ status: SupplierStatus.INACTIVE }),
      );
      await expect(
        service.deactivate({ supplierId: 'supplier-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('deactivate camino feliz: ACTIVE -> INACTIVE, audita con previousStatus', async () => {
      prisma.tx.supplier.findUnique.mockResolvedValue(
        makeSupplierRow({ status: SupplierStatus.ACTIVE }),
      );
      prisma.tx.supplier.update.mockResolvedValue(
        makeSupplierRow({ status: SupplierStatus.INACTIVE }),
      );
      await service.deactivate({
        supplierId: 'supplier-1',
        actorUserId: ACTOR_ID,
      });
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: { previousStatus: SupplierStatus };
      };
      expect(call.action).toBe(AuditAction.SUPPLIER_DEACTIVATED);
      expect(call.metadata.previousStatus).toBe(SupplierStatus.ACTIVE);
    });

    it('proveedor inexistente: NotFoundException', async () => {
      prisma.tx.supplier.findUnique.mockResolvedValue(null);
      await expect(
        service.activate({ supplierId: 'missing-id', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
