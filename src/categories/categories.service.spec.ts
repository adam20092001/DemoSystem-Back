import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CategoryStatus, RoleName } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { CategoriesService } from './categories.service';

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

interface CategoryFindUniqueArgs {
  where: { id?: string; code?: string };
}
interface CategoryCreateArgs {
  data: Record<string, unknown>;
}
interface CategoryUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}
interface CategoryCountArgs {
  where?: Record<string, unknown>;
}
interface CategoryFindManyArgs {
  where?: Record<string, unknown>;
  skip?: number;
  take?: number;
}
interface ProductCountArgs {
  where?: Record<string, unknown>;
}

function makeCategoryRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cat-1',
    code: 'MAQ_CONSTRUCCION',
    name: 'Máquinas de construcción',
    description: null,
    parentId: null,
    status: CategoryStatus.ACTIVE,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    category: {
      findUnique: jest.fn<Promise<unknown>, [CategoryFindUniqueArgs]>(),
      create: jest.fn<Promise<unknown>, [CategoryCreateArgs]>(),
      update: jest.fn<Promise<unknown>, [CategoryUpdateArgs]>(),
      count: jest.fn<Promise<number>, [CategoryCountArgs?]>(),
    },
    product: {
      count: jest.fn<Promise<number>, [ProductCountArgs?]>(),
    },
  };

  return {
    tx,
    category: {
      findUnique: jest.fn<Promise<unknown>, [CategoryFindUniqueArgs]>(),
      findMany: jest.fn<Promise<unknown[]>, [CategoryFindManyArgs]>(),
      count: jest.fn<Promise<number>, [CategoryCountArgs?]>(),
    },
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

describe('CategoriesService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: CategoriesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);

    service = new CategoriesService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  describe('createCategory', () => {
    const validInput = {
      code: '  maq_construccion  ',
      name: '  Máquinas de Construcción  ',
      description: '  Equipos pesados  ',
      actorUserId: ACTOR_ID,
      ipAddress: '10.0.0.1',
    };

    beforeEach(() => {
      prisma.tx.category.create.mockResolvedValue(makeCategoryRow());
    });

    it('crea la categoría y devuelve la forma segura', async () => {
      const result = await service.createCategory(validInput);

      expect(result.code).toBe('MAQ_CONSTRUCCION');
      expect(result.status).toBe(CategoryStatus.ACTIVE);
    });

    it('normaliza code (trim+uppercase) y name (trim, sin cambiar mayúsculas)', async () => {
      await service.createCategory(validInput);

      const createArgs = prisma.tx.category.create.mock.calls[0][0];
      expect(createArgs.data.code).toBe('MAQ_CONSTRUCCION');
      expect(createArgs.data.name).toBe('Máquinas de Construcción');
      expect(createArgs.data.description).toBe('Equipos pesados');
      expect(createArgs.data.status).toBe(CategoryStatus.ACTIVE);
    });

    it('descripción vacía o solo espacios se guarda como null', async () => {
      await service.createCategory({ ...validInput, description: '   ' });

      const createArgs = prisma.tx.category.create.mock.calls[0][0];
      expect(createArgs.data.description).toBeNull();
    });

    it('valida que el padre exista y esté ACTIVE antes de crear', async () => {
      prisma.tx.category.findUnique.mockResolvedValue({
        status: CategoryStatus.ACTIVE,
      });

      await service.createCategory({ ...validInput, parentId: 'parent-1' });

      expect(prisma.tx.category.findUnique).toHaveBeenCalledWith({
        where: { id: 'parent-1' },
        select: { status: true },
      });
      const createArgs = prisma.tx.category.create.mock.calls[0][0];
      expect(createArgs.data.parentId).toBe('parent-1');
    });

    it('padre inexistente lanza NotFoundException', async () => {
      prisma.tx.category.findUnique.mockResolvedValue(null);

      await expect(
        service.createCategory({ ...validInput, parentId: 'missing' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.tx.category.create).not.toHaveBeenCalled();
    });

    it('padre INACTIVE lanza ConflictException', async () => {
      prisma.tx.category.findUnique.mockResolvedValue({
        status: CategoryStatus.INACTIVE,
      });

      await expect(
        service.createCategory({ ...validInput, parentId: 'parent-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.category.create).not.toHaveBeenCalled();
    });

    it('propaga sin capturar un error de código duplicado', async () => {
      prisma.tx.category.create.mockRejectedValue(
        new Error('P2002 simulado: code'),
      );

      await expect(service.createCategory(validInput)).rejects.toThrow(
        'P2002 simulado: code',
      );
    });

    it('propaga sin capturar un error de nombre duplicado', async () => {
      prisma.tx.category.create.mockRejectedValue(
        new Error('P2002 simulado: name'),
      );

      await expect(service.createCategory(validInput)).rejects.toThrow(
        'P2002 simulado: name',
      );
    });

    it('registra CATEGORY_CREATED dentro de la misma transacción', async () => {
      await service.createCategory(validInput);

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CATEGORY_CREATED,
          userId: ACTOR_ID,
          client: prisma.tx,
        }),
      );
    });

    it('revierte la operación si la auditoría falla (transacción simulada)', async () => {
      auditService.record.mockRejectedValue(new Error('fallo de auditoría'));

      await expect(service.createCategory(validInput)).rejects.toThrow(
        'fallo de auditoría',
      );
      expect(prisma.tx.category.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateCategory', () => {
    it('rechaza un update sin ningún campo con BadRequestException', async () => {
      await expect(
        service.updateCategory({ categoryId: 'cat-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('edita correctamente y registra CATEGORY_UPDATED', async () => {
      prisma.tx.category.findUnique.mockResolvedValue({
        id: 'cat-1',
        code: 'MAQ_CONSTRUCCION',
      });
      prisma.tx.category.update.mockResolvedValue(
        makeCategoryRow({ name: 'Nuevo nombre' }),
      );

      const result = await service.updateCategory({
        categoryId: 'cat-1',
        name: '  Nuevo nombre  ',
        actorUserId: ACTOR_ID,
      });

      expect(result.name).toBe('Nuevo nombre');
      const updateArgs = prisma.tx.category.update.mock.calls[0][0];
      expect(updateArgs.data.name).toBe('Nuevo nombre');
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CATEGORY_UPDATED,
          metadata: { updatedFields: ['name'] },
        }),
      );
    });

    it('lanza NotFoundException si la categoría no existe', async () => {
      prisma.tx.category.findUnique.mockResolvedValue(null);

      await expect(
        service.updateCategory({
          categoryId: 'missing',
          name: 'Cualquiera',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('ciclos y auto-padre', () => {
      it('rechaza auto-padre con BadRequestException', async () => {
        prisma.tx.category.findUnique.mockResolvedValue({
          id: 'cat-1',
          code: 'X',
        });

        await expect(
          service.updateCategory({
            categoryId: 'cat-1',
            parentId: 'cat-1',
            actorUserId: ACTOR_ID,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.tx.category.update).not.toHaveBeenCalled();
      });

      it('rechaza un ciclo directo (A intenta ser hija de su propia hija B)', async () => {
        const db: Record<string, unknown> = {
          'cat-a': { id: 'cat-a', code: 'A' },
          'cat-b': {
            id: 'cat-b',
            status: CategoryStatus.ACTIVE,
            parentId: 'cat-a',
          },
        };
        prisma.tx.category.findUnique.mockImplementation(({ where }) =>
          Promise.resolve(db[where.id as string] ?? null),
        );

        await expect(
          service.updateCategory({
            categoryId: 'cat-a',
            parentId: 'cat-b',
            actorUserId: ACTOR_ID,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.tx.category.update).not.toHaveBeenCalled();
      });

      it('rechaza un ciclo indirecto (A -> B -> C, A intenta ser hija de C)', async () => {
        const db: Record<string, unknown> = {
          'cat-a': { id: 'cat-a', code: 'A' },
          'cat-b': {
            id: 'cat-b',
            status: CategoryStatus.ACTIVE,
            parentId: 'cat-a',
          },
          'cat-c': {
            id: 'cat-c',
            status: CategoryStatus.ACTIVE,
            parentId: 'cat-b',
          },
        };
        prisma.tx.category.findUnique.mockImplementation(({ where }) =>
          Promise.resolve(db[where.id as string] ?? null),
        );

        await expect(
          service.updateCategory({
            categoryId: 'cat-a',
            parentId: 'cat-c',
            actorUserId: ACTOR_ID,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('rechaza si detecta una jerarquía ya corrupta entre otros nodos', async () => {
        const db: Record<string, unknown> = {
          'cat-f': { id: 'cat-f', code: 'F' },
          'cat-d': {
            id: 'cat-d',
            status: CategoryStatus.ACTIVE,
            parentId: 'cat-e',
          },
          'cat-e': {
            id: 'cat-e',
            status: CategoryStatus.ACTIVE,
            parentId: 'cat-d',
          },
        };
        prisma.tx.category.findUnique.mockImplementation(({ where }) =>
          Promise.resolve(db[where.id as string] ?? null),
        );

        await expect(
          service.updateCategory({
            categoryId: 'cat-f',
            parentId: 'cat-d',
            actorUserId: ACTOR_ID,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('permite reasignar un padre válido, activo y sin ciclo', async () => {
        const db: Record<string, unknown> = {
          'cat-a': { id: 'cat-a', code: 'A' },
          'cat-z': {
            id: 'cat-z',
            status: CategoryStatus.ACTIVE,
            parentId: null,
          },
        };
        prisma.tx.category.findUnique.mockImplementation(({ where }) =>
          Promise.resolve(db[where.id as string] ?? null),
        );
        prisma.tx.category.update.mockResolvedValue(
          makeCategoryRow({ id: 'cat-a', parentId: 'cat-z' }),
        );

        const result = await service.updateCategory({
          categoryId: 'cat-a',
          parentId: 'cat-z',
          actorUserId: ACTOR_ID,
        });

        expect(result.parentId).toBe('cat-z');
      });

      it('parentId=null convierte la categoría en raíz', async () => {
        prisma.tx.category.findUnique.mockResolvedValue({
          id: 'cat-a',
          code: 'A',
        });
        prisma.tx.category.update.mockResolvedValue(
          makeCategoryRow({ parentId: null }),
        );

        await service.updateCategory({
          categoryId: 'cat-a',
          parentId: null,
          actorUserId: ACTOR_ID,
        });

        const updateArgs = prisma.tx.category.update.mock.calls[0][0];
        expect(updateArgs.data.parent).toEqual({ disconnect: true });
      });
    });
  });

  describe('activateCategory', () => {
    it('activa correctamente y registra CATEGORY_ACTIVATED', async () => {
      prisma.tx.category.findUnique.mockResolvedValue({
        id: 'cat-1',
        code: 'MAQ_CONSTRUCCION',
        status: CategoryStatus.INACTIVE,
        parentId: null,
      });
      prisma.tx.category.update.mockResolvedValue(makeCategoryRow());

      const result = await service.activateCategory({
        categoryId: 'cat-1',
        actorUserId: ACTOR_ID,
      });

      expect(result.status).toBe(CategoryStatus.ACTIVE);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.CATEGORY_ACTIVATED }),
      );
    });

    it('rechaza activar si el padre está INACTIVE', async () => {
      prisma.tx.category.findUnique.mockImplementation(({ where }) => {
        if (where.id === 'cat-1') {
          return Promise.resolve({
            id: 'cat-1',
            code: 'X',
            status: CategoryStatus.INACTIVE,
            parentId: 'parent-1',
          });
        }
        if (where.id === 'parent-1') {
          return Promise.resolve({ status: CategoryStatus.INACTIVE });
        }
        return Promise.resolve(null);
      });

      await expect(
        service.activateCategory({
          categoryId: 'cat-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.category.update).not.toHaveBeenCalled();
    });

    it('lanza ConflictException si ya está activa', async () => {
      prisma.tx.category.findUnique.mockResolvedValue({
        id: 'cat-1',
        code: 'X',
        status: CategoryStatus.ACTIVE,
        parentId: null,
      });

      await expect(
        service.activateCategory({
          categoryId: 'cat-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('lanza NotFoundException si no existe', async () => {
      prisma.tx.category.findUnique.mockResolvedValue(null);

      await expect(
        service.activateCategory({
          categoryId: 'missing',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deactivateCategory', () => {
    it('desactiva correctamente y registra CATEGORY_DEACTIVATED', async () => {
      prisma.tx.category.findUnique.mockResolvedValue({
        id: 'cat-1',
        code: 'MAQ_CONSTRUCCION',
        status: CategoryStatus.ACTIVE,
      });
      prisma.tx.category.count.mockResolvedValue(0);
      prisma.tx.product.count.mockResolvedValue(0);
      prisma.tx.category.update.mockResolvedValue(
        makeCategoryRow({ status: CategoryStatus.INACTIVE }),
      );

      const result = await service.deactivateCategory({
        categoryId: 'cat-1',
        actorUserId: ACTOR_ID,
      });

      expect(result.status).toBe(CategoryStatus.INACTIVE);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.CATEGORY_DEACTIVATED }),
      );
    });

    it('lanza ConflictException si ya está inactiva', async () => {
      prisma.tx.category.findUnique.mockResolvedValue({
        id: 'cat-1',
        code: 'X',
        status: CategoryStatus.INACTIVE,
      });

      await expect(
        service.deactivateCategory({
          categoryId: 'cat-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('bloquea la desactivación si existe al menos un hijo ACTIVE', async () => {
      prisma.tx.category.findUnique.mockResolvedValue({
        id: 'cat-1',
        code: 'X',
        status: CategoryStatus.ACTIVE,
      });
      prisma.tx.category.count.mockResolvedValue(1);

      await expect(
        service.deactivateCategory({
          categoryId: 'cat-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.category.update).not.toHaveBeenCalled();
    });

    it('bloquea la desactivación si existe al menos un producto ACTIVE', async () => {
      prisma.tx.category.findUnique.mockResolvedValue({
        id: 'cat-1',
        code: 'X',
        status: CategoryStatus.ACTIVE,
      });
      prisma.tx.category.count.mockResolvedValue(0);
      prisma.tx.product.count.mockResolvedValue(1);

      await expect(
        service.deactivateCategory({
          categoryId: 'cat-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.category.update).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si no existe', async () => {
      prisma.tx.category.findUnique.mockResolvedValue(null);

      await expect(
        service.deactivateCategory({
          categoryId: 'missing',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listCategories', () => {
    it('devuelve una respuesta paginada con los defaults', async () => {
      prisma.category.findMany.mockResolvedValue([makeCategoryRow()]);
      prisma.category.count.mockResolvedValue(1);

      const result = await service.listCategories({}, RoleName.ADMIN);

      expect(result).toEqual({
        data: [expect.objectContaining({ id: 'cat-1' })],
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
      expect(prisma.category.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 20,
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
      );
    });

    it('SELLER siempre ve solo ACTIVE, aunque pida status=INACTIVE', async () => {
      prisma.category.findMany.mockResolvedValue([]);
      prisma.category.count.mockResolvedValue(0);

      await service.listCategories(
        { status: CategoryStatus.INACTIVE },
        RoleName.SELLER,
      );

      const args = prisma.category.findMany.mock.calls[0][0];
      expect(args.where?.status).toBe(CategoryStatus.ACTIVE);
    });

    it.each([RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT])(
      '%s puede pedir explícitamente status=INACTIVE',
      async (role) => {
        prisma.category.findMany.mockResolvedValue([]);
        prisma.category.count.mockResolvedValue(0);

        await service.listCategories({ status: CategoryStatus.INACTIVE }, role);

        const args = prisma.category.findMany.mock.calls[0][0];
        expect(args.where?.status).toBe(CategoryStatus.INACTIVE);
      },
    );

    it.each([RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT])(
      '%s sin filtro de status ve ambos estados (sin forzar ACTIVE)',
      async (role) => {
        prisma.category.findMany.mockResolvedValue([]);
        prisma.category.count.mockResolvedValue(0);

        await service.listCategories({}, role);

        const args = prisma.category.findMany.mock.calls[0][0];
        expect(args.where?.status).toBeUndefined();
      },
    );
  });

  describe('findCategoryById', () => {
    it('devuelve la categoría si existe', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategoryRow());

      const result = await service.findCategoryById('cat-1', RoleName.ADMIN);

      expect(result.id).toBe('cat-1');
    });

    it('lanza NotFoundException si no existe', async () => {
      prisma.category.findUnique.mockResolvedValue(null);

      await expect(
        service.findCategoryById('missing', RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('oculta una categoría INACTIVE a SELLER con 404', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategoryRow({ status: CategoryStatus.INACTIVE }),
      );

      await expect(
        service.findCategoryById('cat-1', RoleName.SELLER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT])(
      '%s sí puede ver el detalle de una categoría INACTIVE',
      async (role) => {
        prisma.category.findUnique.mockResolvedValue(
          makeCategoryRow({ status: CategoryStatus.INACTIVE }),
        );

        const result = await service.findCategoryById('cat-1', role);

        expect(result.status).toBe(CategoryStatus.INACTIVE);
      },
    );
  });
});
