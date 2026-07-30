import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ProductSpecificationsService } from './product-specifications.service';

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

interface ProductFindUniqueArgs {
  where: { id: string };
  select?: Record<string, unknown>;
}
interface SpecFindUniqueArgs {
  where: { id: string };
}
interface SpecCreateArgs {
  data: Record<string, unknown>;
}
interface SpecUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}
interface SpecDeleteArgs {
  where: { id: string };
}

function makeSpecRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'spec-1',
    name: 'Color',
    value: 'Rojo',
    unit: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    product: {
      findUnique: jest.fn<Promise<unknown>, [ProductFindUniqueArgs]>(),
    },
    productSpecification: {
      findUnique: jest.fn<Promise<unknown>, [SpecFindUniqueArgs]>(),
      create: jest.fn<Promise<unknown>, [SpecCreateArgs]>(),
      update: jest.fn<Promise<unknown>, [SpecUpdateArgs]>(),
      delete: jest.fn<Promise<unknown>, [SpecDeleteArgs]>(),
    },
  };

  return {
    tx,
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return {
    record: jest.fn<Promise<void>, [Record<string, unknown>]>(),
  };
}

describe('ProductSpecificationsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: ProductSpecificationsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);

    service = new ProductSpecificationsService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  describe('createSpecification', () => {
    const validInput = {
      productId: 'product-1',
      name: '  Color  ',
      value: '  Rojo  ',
      unit: '  cm  ',
      sortOrder: 2,
      actorUserId: ACTOR_ID,
      ipAddress: '10.0.0.1',
    };

    beforeEach(() => {
      prisma.tx.product.findUnique.mockResolvedValue({ id: 'product-1' });
      prisma.tx.productSpecification.create.mockResolvedValue(makeSpecRow());
    });

    it('crea la especificación y devuelve la forma segura', async () => {
      const result = await service.createSpecification(validInput);

      expect(result.id).toBe('spec-1');
    });

    it('normaliza name, value y unit (trim)', async () => {
      await service.createSpecification(validInput);

      const createArgs = prisma.tx.productSpecification.create.mock.calls[0][0];
      expect(createArgs.data.name).toBe('Color');
      expect(createArgs.data.value).toBe('Rojo');
      expect(createArgs.data.unit).toBe('cm');
    });

    it('unit ausente se guarda como null', async () => {
      await service.createSpecification({ ...validInput, unit: undefined });

      const createArgs = prisma.tx.productSpecification.create.mock.calls[0][0];
      expect(createArgs.data.unit).toBeNull();
    });

    it('sortOrder por defecto es 0 cuando no se envía', async () => {
      await service.createSpecification({
        ...validInput,
        sortOrder: undefined,
      });

      const createArgs = prisma.tx.productSpecification.create.mock.calls[0][0];
      expect(createArgs.data.sortOrder).toBe(0);
    });

    it('lanza NotFoundException si el producto no existe', async () => {
      prisma.tx.product.findUnique.mockResolvedValue(null);

      await expect(
        service.createSpecification(validInput),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('propaga sin capturar un error de nombre duplicado', async () => {
      prisma.tx.productSpecification.create.mockRejectedValue(
        new Error('P2002 simulado'),
      );

      await expect(service.createSpecification(validInput)).rejects.toThrow(
        'P2002 simulado',
      );
    });

    it('registra PRODUCT_SPECIFICATION_CHANGED con operation=CREATED y solo specificationName', async () => {
      await service.createSpecification(validInput);

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PRODUCT_SPECIFICATION_CHANGED,
          entityType: 'Product',
          entityId: 'product-1',
          metadata: { operation: 'CREATED', specificationName: 'Color' },
          client: prisma.tx,
        }),
      );
    });

    it('nunca incluye value en la metadata de auditoría', async () => {
      await service.createSpecification(validInput);

      const auditArgs = auditService.record.mock.calls[0][0];
      expect(auditArgs.metadata).not.toHaveProperty('value');
    });

    it('revierte la operación si la auditoría falla (transacción simulada)', async () => {
      auditService.record.mockRejectedValue(new Error('fallo de auditoría'));

      await expect(service.createSpecification(validInput)).rejects.toThrow(
        'fallo de auditoría',
      );
      expect(prisma.tx.productSpecification.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateSpecification', () => {
    it('rechaza un update sin ningún campo con BadRequestException, sin abrir transacción', async () => {
      await expect(
        service.updateSpecification({
          productId: 'product-1',
          specificationId: 'spec-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('edita correctamente y registra operation=UPDATED', async () => {
      prisma.tx.productSpecification.findUnique.mockResolvedValue({
        id: 'spec-1',
        productId: 'product-1',
        name: 'Color',
      });
      prisma.tx.productSpecification.update.mockResolvedValue(
        makeSpecRow({ value: 'Azul' }),
      );

      const result = await service.updateSpecification({
        productId: 'product-1',
        specificationId: 'spec-1',
        value: '  Azul  ',
        actorUserId: ACTOR_ID,
      });

      expect(result.value).toBe('Azul');
      const updateArgs = prisma.tx.productSpecification.update.mock.calls[0][0];
      expect(updateArgs.data.value).toBe('Azul');
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PRODUCT_SPECIFICATION_CHANGED,
          metadata: { operation: 'UPDATED', specificationName: 'Color' },
        }),
      );
    });

    it('unit=null explícito limpia el campo', async () => {
      prisma.tx.productSpecification.findUnique.mockResolvedValue({
        id: 'spec-1',
        productId: 'product-1',
        name: 'Color',
      });
      prisma.tx.productSpecification.update.mockResolvedValue(makeSpecRow());

      await service.updateSpecification({
        productId: 'product-1',
        specificationId: 'spec-1',
        unit: null,
        actorUserId: ACTOR_ID,
      });

      const updateArgs = prisma.tx.productSpecification.update.mock.calls[0][0];
      expect(updateArgs.data.unit).toBeNull();
    });

    it('usa el nombre actualizado en la metadata cuando name cambia', async () => {
      prisma.tx.productSpecification.findUnique.mockResolvedValue({
        id: 'spec-1',
        productId: 'product-1',
        name: 'Color',
      });
      prisma.tx.productSpecification.update.mockResolvedValue(
        makeSpecRow({ name: 'Tono' }),
      );

      await service.updateSpecification({
        productId: 'product-1',
        specificationId: 'spec-1',
        name: '  Tono  ',
        actorUserId: ACTOR_ID,
      });

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { operation: 'UPDATED', specificationName: 'Tono' },
        }),
      );
    });

    it('lanza NotFoundException (no 403) si la especificación pertenece a otro producto', async () => {
      prisma.tx.productSpecification.findUnique.mockResolvedValue({
        id: 'spec-1',
        productId: 'other-product',
        name: 'Color',
      });

      await expect(
        service.updateSpecification({
          productId: 'product-1',
          specificationId: 'spec-1',
          value: 'Azul',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lanza NotFoundException si la especificación no existe', async () => {
      prisma.tx.productSpecification.findUnique.mockResolvedValue(null);

      await expect(
        service.updateSpecification({
          productId: 'product-1',
          specificationId: 'missing',
          value: 'Azul',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('propaga sin capturar un error de nombre duplicado', async () => {
      prisma.tx.productSpecification.findUnique.mockResolvedValue({
        id: 'spec-1',
        productId: 'product-1',
        name: 'Color',
      });
      prisma.tx.productSpecification.update.mockRejectedValue(
        new Error('P2002 simulado'),
      );

      await expect(
        service.updateSpecification({
          productId: 'product-1',
          specificationId: 'spec-1',
          name: 'Duplicado',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toThrow('P2002 simulado');
    });

    it('revierte la operación si la auditoría falla (transacción simulada)', async () => {
      prisma.tx.productSpecification.findUnique.mockResolvedValue({
        id: 'spec-1',
        productId: 'product-1',
        name: 'Color',
      });
      prisma.tx.productSpecification.update.mockResolvedValue(makeSpecRow());
      auditService.record.mockRejectedValue(new Error('fallo de auditoría'));

      await expect(
        service.updateSpecification({
          productId: 'product-1',
          specificationId: 'spec-1',
          value: 'Azul',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toThrow('fallo de auditoría');
    });
  });

  describe('deleteSpecification', () => {
    it('elimina físicamente y registra operation=DELETED', async () => {
      prisma.tx.productSpecification.findUnique.mockResolvedValue({
        id: 'spec-1',
        productId: 'product-1',
        name: 'Color',
      });
      prisma.tx.productSpecification.delete.mockResolvedValue(makeSpecRow());

      await service.deleteSpecification({
        productId: 'product-1',
        specificationId: 'spec-1',
        actorUserId: ACTOR_ID,
      });

      expect(prisma.tx.productSpecification.delete).toHaveBeenCalledWith({
        where: { id: 'spec-1' },
      });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PRODUCT_SPECIFICATION_CHANGED,
          metadata: { operation: 'DELETED', specificationName: 'Color' },
        }),
      );
    });

    it('lanza NotFoundException si la especificación no existe', async () => {
      prisma.tx.productSpecification.findUnique.mockResolvedValue(null);

      await expect(
        service.deleteSpecification({
          productId: 'product-1',
          specificationId: 'missing',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.tx.productSpecification.delete).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si la especificación pertenece a otro producto', async () => {
      prisma.tx.productSpecification.findUnique.mockResolvedValue({
        id: 'spec-1',
        productId: 'other-product',
        name: 'Color',
      });

      await expect(
        service.deleteSpecification({
          productId: 'product-1',
          specificationId: 'spec-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.tx.productSpecification.delete).not.toHaveBeenCalled();
    });

    it('no modifica el producto en ningún momento', async () => {
      prisma.tx.productSpecification.findUnique.mockResolvedValue({
        id: 'spec-1',
        productId: 'product-1',
        name: 'Color',
      });
      prisma.tx.productSpecification.delete.mockResolvedValue(makeSpecRow());

      await service.deleteSpecification({
        productId: 'product-1',
        specificationId: 'spec-1',
        actorUserId: ACTOR_ID,
      });

      expect(prisma.tx.product.findUnique).not.toHaveBeenCalled();
    });

    it('revierte la operación si la auditoría falla (transacción simulada)', async () => {
      prisma.tx.productSpecification.findUnique.mockResolvedValue({
        id: 'spec-1',
        productId: 'product-1',
        name: 'Color',
      });
      prisma.tx.productSpecification.delete.mockResolvedValue(makeSpecRow());
      auditService.record.mockRejectedValue(new Error('fallo de auditoría'));

      await expect(
        service.deleteSpecification({
          productId: 'product-1',
          specificationId: 'spec-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toThrow('fallo de auditoría');
    });
  });
});
