import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CategoryStatus,
  Prisma,
  ProductStatus,
  ProductType,
  RoleName,
  UnitStatus,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ProductsService } from './products.service';

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

interface ProductFindUniqueArgs {
  where: { id?: string };
  select?: Record<string, unknown>;
}
interface ProductCreateArgs {
  data: Record<string, unknown>;
}
interface ProductUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}
interface ProductFindManyArgs {
  where?: Record<string, unknown>;
  skip?: number;
  take?: number;
  orderBy?: unknown;
}
interface ProductCountArgs {
  where?: Record<string, unknown>;
}
interface CategoryFindUniqueArgs {
  where: { id: string };
}
interface UnitFindUniqueArgs {
  where: { id: string };
}

function makeProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'product-1',
    sku: 'SKU-1',
    name: 'Producto uno',
    brand: null,
    productType: ProductType.PRODUCT,
    salePrice: new Prisma.Decimal('19.9'),
    isInventoryTracked: true,
    stockCurrent: new Prisma.Decimal(0),
    stockMinimum: new Prisma.Decimal(0),
    status: ProductStatus.ACTIVE,
    internalNotes: null,
    createdAt: NOW,
    updatedAt: NOW,
    category: { id: 'category-1', code: 'CAT1', name: 'Categoria uno' },
    unit: {
      id: 'unit-1',
      code: 'UN',
      name: 'Unidad',
      abbreviation: 'un',
      allowDecimal: false,
    },
    commercialDescription: null,
    specifications: [],
    images: [],
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    product: {
      create: jest.fn<Promise<unknown>, [ProductCreateArgs]>(),
      findUnique: jest.fn<Promise<unknown>, [ProductFindUniqueArgs]>(),
      update: jest.fn<Promise<unknown>, [ProductUpdateArgs]>(),
    },
    category: {
      findUnique: jest.fn<Promise<unknown>, [CategoryFindUniqueArgs]>(),
    },
    unit: {
      findUnique: jest.fn<Promise<unknown>, [UnitFindUniqueArgs]>(),
    },
  };

  return {
    tx,
    product: {
      findUnique: jest.fn<Promise<unknown>, [ProductFindUniqueArgs]>(),
      findMany: jest.fn<Promise<unknown[]>, [ProductFindManyArgs]>(),
      count: jest.fn<Promise<number>, [ProductCountArgs?]>(),
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

describe('ProductsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: ProductsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);

    service = new ProductsService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );

    prisma.tx.category.findUnique.mockResolvedValue({
      status: CategoryStatus.ACTIVE,
    });
    prisma.tx.unit.findUnique.mockResolvedValue({ status: UnitStatus.ACTIVE });
  });

  describe('createProduct', () => {
    const validInput = {
      sku: '  sku-1  ',
      name: '  Producto Uno  ',
      brand: '  Marca  ',
      productType: ProductType.PRODUCT,
      categoryId: 'category-1',
      unitId: 'unit-1',
      salePrice: '19.90',
      commercialDescription: '  Descripción  ',
      internalNotes: '  Nota interna  ',
      isInventoryTracked: true,
      stockMinimum: '5',
      actorUserId: ACTOR_ID,
      ipAddress: '10.0.0.1',
    };

    beforeEach(() => {
      prisma.tx.product.create.mockResolvedValue(makeProductRow());
    });

    it('crea el producto y devuelve la forma segura', async () => {
      const result = await service.createProduct(validInput);

      expect(result.id).toBe('product-1');
      expect(result.status).toBe(ProductStatus.ACTIVE);
    });

    it('normaliza sku (trim+upper), name (trim sin cambiar mayúsculas) y campos opcionales (trim)', async () => {
      await service.createProduct(validInput);

      const createArgs = prisma.tx.product.create.mock.calls[0][0];
      expect(createArgs.data.sku).toBe('SKU-1');
      expect(createArgs.data.name).toBe('Producto Uno');
      expect(createArgs.data.brand).toBe('Marca');
      expect(createArgs.data.commercialDescription).toBe('Descripción');
      expect(createArgs.data.internalNotes).toBe('Nota interna');
    });

    it('brand/commercialDescription/internalNotes vacíos o ausentes se guardan como null', async () => {
      await service.createProduct({
        ...validInput,
        brand: undefined,
        commercialDescription: undefined,
        internalNotes: undefined,
      });

      const createArgs = prisma.tx.product.create.mock.calls[0][0];
      expect(createArgs.data.brand).toBeNull();
      expect(createArgs.data.commercialDescription).toBeNull();
      expect(createArgs.data.internalNotes).toBeNull();
    });

    it('stockCurrent siempre se crea como Decimal(0), sin importar el input', async () => {
      await service.createProduct(validInput);

      const createArgs = prisma.tx.product.create.mock.calls[0][0];
      const stockCurrent = createArgs.data.stockCurrent as Prisma.Decimal;
      expect(stockCurrent.equals(0)).toBe(true);
    });

    it('status siempre se crea como ACTIVE', async () => {
      await service.createProduct(validInput);

      const createArgs = prisma.tx.product.create.mock.calls[0][0];
      expect(createArgs.data.status).toBe(ProductStatus.ACTIVE);
    });

    it('lanza NotFoundException si la categoría no existe', async () => {
      prisma.tx.category.findUnique.mockResolvedValue(null);

      await expect(service.createProduct(validInput)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('lanza ConflictException si la categoría no está ACTIVE', async () => {
      prisma.tx.category.findUnique.mockResolvedValue({
        status: CategoryStatus.INACTIVE,
      });

      await expect(service.createProduct(validInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('lanza NotFoundException si la unidad no existe', async () => {
      prisma.tx.unit.findUnique.mockResolvedValue(null);

      await expect(service.createProduct(validInput)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('lanza ConflictException si la unidad no está ACTIVE', async () => {
      prisma.tx.unit.findUnique.mockResolvedValue({
        status: UnitStatus.INACTIVE,
      });

      await expect(service.createProduct(validInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('propaga sin capturar un error de SKU duplicado', async () => {
      prisma.tx.product.create.mockRejectedValue(new Error('P2002 simulado'));

      await expect(service.createProduct(validInput)).rejects.toThrow(
        'P2002 simulado',
      );
    });

    it('rechaza SERVICE con isInventoryTracked=true', async () => {
      await expect(
        service.createProduct({
          ...validInput,
          productType: ProductType.SERVICE,
          isInventoryTracked: true,
          stockMinimum: '0',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rechaza SERVICE con stockMinimum distinto de cero', async () => {
      await expect(
        service.createProduct({
          ...validInput,
          productType: ProductType.SERVICE,
          isInventoryTracked: false,
          stockMinimum: '3',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('permite SERVICE con isInventoryTracked=false y stockMinimum=0', async () => {
      prisma.tx.product.create.mockResolvedValue(
        makeProductRow({ productType: ProductType.SERVICE }),
      );

      await expect(
        service.createProduct({
          ...validInput,
          productType: ProductType.SERVICE,
          isInventoryTracked: false,
          stockMinimum: '0',
        }),
      ).resolves.toBeDefined();
    });

    it('permite PRODUCT con isInventoryTracked=true y stockMinimum>0', async () => {
      await expect(service.createProduct(validInput)).resolves.toBeDefined();
    });

    it('registra PRODUCT_CREATED con metadata exacta dentro de la transacción', async () => {
      await service.createProduct(validInput);

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PRODUCT_CREATED,
          userId: ACTOR_ID,
          client: prisma.tx,
          metadata: {
            sku: 'SKU-1',
            productType: ProductType.PRODUCT,
            categoryId: 'category-1',
            unitId: 'unit-1',
          },
        }),
      );
    });

    it('revierte la operación si la auditoría falla (transacción simulada)', async () => {
      auditService.record.mockRejectedValue(new Error('fallo de auditoría'));

      await expect(service.createProduct(validInput)).rejects.toThrow(
        'fallo de auditoría',
      );
      expect(prisma.tx.product.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateProduct', () => {
    it('rechaza un update sin ningún campo con BadRequestException, sin abrir transacción', async () => {
      await expect(
        service.updateProduct({
          productId: 'product-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el producto no existe', async () => {
      prisma.tx.product.findUnique.mockResolvedValue(null);

      await expect(
        service.updateProduct({
          productId: 'missing',
          name: 'X',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('con un producto PRODUCT existente', () => {
      beforeEach(() => {
        prisma.tx.product.findUnique.mockResolvedValue({
          id: 'product-1',
          sku: 'SKU-1',
          productType: ProductType.PRODUCT,
          isInventoryTracked: true,
          stockMinimum: new Prisma.Decimal(0),
          salePrice: new Prisma.Decimal('10.00'),
        });
        prisma.tx.product.update.mockResolvedValue(makeProductRow());
      });

      it('edita correctamente y registra PRODUCT_UPDATED con updatedFields', async () => {
        const result = await service.updateProduct({
          productId: 'product-1',
          name: '  Nuevo Nombre  ',
          actorUserId: ACTOR_ID,
        });

        expect(result.id).toBe('product-1');
        const updateArgs = prisma.tx.product.update.mock.calls[0][0];
        expect(updateArgs.data.name).toBe('Nuevo Nombre');
        expect(auditService.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.PRODUCT_UPDATED,
            metadata: { updatedFields: ['name'] },
          }),
        );
      });

      it('nunca envía stockCurrent en el data de actualización', async () => {
        await service.updateProduct({
          productId: 'product-1',
          name: 'X',
          actorUserId: ACTOR_ID,
        });

        const updateArgs = prisma.tx.product.update.mock.calls[0][0];
        expect(updateArgs.data.stockCurrent).toBeUndefined();
      });

      it('null explícito en brand/commercialDescription/internalNotes limpia el campo', async () => {
        await service.updateProduct({
          productId: 'product-1',
          brand: null,
          commercialDescription: null,
          internalNotes: null,
          actorUserId: ACTOR_ID,
        });

        const updateArgs = prisma.tx.product.update.mock.calls[0][0];
        expect(updateArgs.data.brand).toBeNull();
        expect(updateArgs.data.commercialDescription).toBeNull();
        expect(updateArgs.data.internalNotes).toBeNull();
      });

      it('valida categoría al reasignar categoryId', async () => {
        prisma.tx.category.findUnique.mockResolvedValue(null);

        await expect(
          service.updateProduct({
            productId: 'product-1',
            categoryId: 'other-category',
            actorUserId: ACTOR_ID,
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('valida unidad al reasignar unitId', async () => {
        prisma.tx.unit.findUnique.mockResolvedValue({
          status: UnitStatus.INACTIVE,
        });

        await expect(
          service.updateProduct({
            productId: 'product-1',
            unitId: 'other-unit',
            actorUserId: ACTOR_ID,
          }),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('detecta un cambio real de precio y registra PRODUCT_PRICE_CHANGED', async () => {
        await service.updateProduct({
          productId: 'product-1',
          salePrice: '25.50',
          actorUserId: ACTOR_ID,
        });

        expect(auditService.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.PRODUCT_PRICE_CHANGED,
            metadata: { oldPrice: '10.00', newPrice: '25.50' },
          }),
        );
      });

      it('no registra PRODUCT_PRICE_CHANGED cuando el nuevo precio es equivalente ("10.0" vs "10.00")', async () => {
        await service.updateProduct({
          productId: 'product-1',
          salePrice: '10.0',
          actorUserId: ACTOR_ID,
        });

        expect(auditService.record).not.toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.PRODUCT_PRICE_CHANGED,
          }),
        );
      });
    });

    describe('reglas efectivas PRODUCT/SERVICE en conversiones', () => {
      it('rechaza convertir a SERVICE sin enviar isInventoryTracked=false', async () => {
        prisma.tx.product.findUnique.mockResolvedValue({
          id: 'product-1',
          sku: 'SKU-1',
          productType: ProductType.PRODUCT,
          isInventoryTracked: true,
          stockMinimum: new Prisma.Decimal(0),
          salePrice: new Prisma.Decimal('10.00'),
        });

        await expect(
          service.updateProduct({
            productId: 'product-1',
            productType: ProductType.SERVICE,
            actorUserId: ACTOR_ID,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('rechaza convertir a SERVICE con stockMinimum almacenado > 0 sin resetearlo', async () => {
        prisma.tx.product.findUnique.mockResolvedValue({
          id: 'product-1',
          sku: 'SKU-1',
          productType: ProductType.PRODUCT,
          isInventoryTracked: false,
          stockMinimum: new Prisma.Decimal('5'),
          salePrice: new Prisma.Decimal('10.00'),
        });

        await expect(
          service.updateProduct({
            productId: 'product-1',
            productType: ProductType.SERVICE,
            isInventoryTracked: false,
            actorUserId: ACTOR_ID,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('permite convertir a SERVICE cuando ambos valores compatibles se envían', async () => {
        prisma.tx.product.findUnique.mockResolvedValue({
          id: 'product-1',
          sku: 'SKU-1',
          productType: ProductType.PRODUCT,
          isInventoryTracked: true,
          stockMinimum: new Prisma.Decimal('5'),
          salePrice: new Prisma.Decimal('10.00'),
        });
        prisma.tx.product.update.mockResolvedValue(
          makeProductRow({ productType: ProductType.SERVICE }),
        );

        await expect(
          service.updateProduct({
            productId: 'product-1',
            productType: ProductType.SERVICE,
            isInventoryTracked: false,
            stockMinimum: '0',
            actorUserId: ACTOR_ID,
          }),
        ).resolves.toBeDefined();
      });

      it('permite convertir SERVICE a PRODUCT sin enviar isInventoryTracked (se mantiene false)', async () => {
        prisma.tx.product.findUnique.mockResolvedValue({
          id: 'product-1',
          sku: 'SKU-1',
          productType: ProductType.SERVICE,
          isInventoryTracked: false,
          stockMinimum: new Prisma.Decimal(0),
          salePrice: new Prisma.Decimal('10.00'),
        });
        prisma.tx.product.update.mockResolvedValue(
          makeProductRow({ productType: ProductType.PRODUCT }),
        );

        await expect(
          service.updateProduct({
            productId: 'product-1',
            productType: ProductType.PRODUCT,
            actorUserId: ACTOR_ID,
          }),
        ).resolves.toBeDefined();
      });
    });
  });

  describe('activateProduct', () => {
    it('activa correctamente y registra PRODUCT_ACTIVATED', async () => {
      prisma.tx.product.findUnique.mockResolvedValue({
        id: 'product-1',
        sku: 'SKU-1',
        status: ProductStatus.INACTIVE,
        productType: ProductType.PRODUCT,
        isInventoryTracked: true,
        stockMinimum: new Prisma.Decimal(0),
        categoryId: 'category-1',
        unitId: 'unit-1',
      });
      prisma.tx.product.update.mockResolvedValue(makeProductRow());

      const result = await service.activateProduct({
        productId: 'product-1',
        actorUserId: ACTOR_ID,
      });

      expect(result.status).toBe(ProductStatus.ACTIVE);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.PRODUCT_ACTIVATED }),
      );
    });

    it('lanza ConflictException si ya está activo', async () => {
      prisma.tx.product.findUnique.mockResolvedValue({
        id: 'product-1',
        sku: 'SKU-1',
        status: ProductStatus.ACTIVE,
        productType: ProductType.PRODUCT,
        isInventoryTracked: true,
        stockMinimum: new Prisma.Decimal(0),
        categoryId: 'category-1',
        unitId: 'unit-1',
      });

      await expect(
        service.activateProduct({
          productId: 'product-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('lanza NotFoundException si no existe', async () => {
      prisma.tx.product.findUnique.mockResolvedValue(null);

      await expect(
        service.activateProduct({
          productId: 'missing',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lanza ConflictException si la categoría del producto ya no está ACTIVE', async () => {
      prisma.tx.product.findUnique.mockResolvedValue({
        id: 'product-1',
        sku: 'SKU-1',
        status: ProductStatus.INACTIVE,
        productType: ProductType.PRODUCT,
        isInventoryTracked: true,
        stockMinimum: new Prisma.Decimal(0),
        categoryId: 'category-1',
        unitId: 'unit-1',
      });
      prisma.tx.category.findUnique.mockResolvedValue({
        status: CategoryStatus.INACTIVE,
      });

      await expect(
        service.activateProduct({
          productId: 'product-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('lanza ConflictException si la unidad del producto ya no está ACTIVE', async () => {
      prisma.tx.product.findUnique.mockResolvedValue({
        id: 'product-1',
        sku: 'SKU-1',
        status: ProductStatus.INACTIVE,
        productType: ProductType.PRODUCT,
        isInventoryTracked: true,
        stockMinimum: new Prisma.Decimal(0),
        categoryId: 'category-1',
        unitId: 'unit-1',
      });
      prisma.tx.unit.findUnique.mockResolvedValue({
        status: UnitStatus.INACTIVE,
      });

      await expect(
        service.activateProduct({
          productId: 'product-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('deactivateProduct', () => {
    it('desactiva correctamente y registra PRODUCT_DEACTIVATED', async () => {
      prisma.tx.product.findUnique.mockResolvedValue({
        id: 'product-1',
        sku: 'SKU-1',
        status: ProductStatus.ACTIVE,
      });
      prisma.tx.product.update.mockResolvedValue(
        makeProductRow({ status: ProductStatus.INACTIVE }),
      );

      const result = await service.deactivateProduct({
        productId: 'product-1',
        actorUserId: ACTOR_ID,
      });

      expect(result.status).toBe(ProductStatus.INACTIVE);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.PRODUCT_DEACTIVATED }),
      );
    });

    it('lanza ConflictException si ya está inactivo', async () => {
      prisma.tx.product.findUnique.mockResolvedValue({
        id: 'product-1',
        sku: 'SKU-1',
        status: ProductStatus.INACTIVE,
      });

      await expect(
        service.deactivateProduct({
          productId: 'product-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('lanza NotFoundException si no existe', async () => {
      prisma.tx.product.findUnique.mockResolvedValue(null);

      await expect(
        service.deactivateProduct({
          productId: 'missing',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listProducts', () => {
    it('devuelve una respuesta paginada con los defaults', async () => {
      prisma.product.findMany.mockResolvedValue([makeProductRow()]);
      prisma.product.count.mockResolvedValue(1);

      const result = await service.listProducts({}, RoleName.ADMIN);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 20,
          orderBy: [{ name: 'asc' }, { sku: 'asc' }],
        }),
      );
    });

    it('filtra por categoryId, unitId, productType e isInventoryTracked', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.listProducts(
        {
          categoryId: 'category-1',
          unitId: 'unit-1',
          productType: ProductType.SERVICE,
          isInventoryTracked: false,
        },
        RoleName.ADMIN,
      );

      const args = prisma.product.findMany.mock.calls[0][0];
      expect(args.where?.categoryId).toBe('category-1');
      expect(args.where?.unitId).toBe('unit-1');
      expect(args.where?.productType).toBe(ProductType.SERVICE);
      expect(args.where?.isInventoryTracked).toBe(false);
    });

    it('busca de forma insensible a mayúsculas por sku, name y brand', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.listProducts({ search: 'abc' }, RoleName.ADMIN);

      const args = prisma.product.findMany.mock.calls[0][0];
      expect(args.where?.OR).toEqual([
        { sku: { contains: 'abc', mode: 'insensitive' } },
        { name: { contains: 'abc', mode: 'insensitive' } },
        { brand: { contains: 'abc', mode: 'insensitive' } },
      ]);
    });

    it('SELLER siempre ve solo ACTIVE, aunque pida status=INACTIVE', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.listProducts(
        { status: ProductStatus.INACTIVE },
        RoleName.SELLER,
      );

      const args = prisma.product.findMany.mock.calls[0][0];
      expect(args.where?.status).toBe(ProductStatus.ACTIVE);
    });

    it.each([RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT])(
      '%s puede pedir explícitamente status=INACTIVE',
      async (role) => {
        prisma.product.findMany.mockResolvedValue([]);
        prisma.product.count.mockResolvedValue(0);

        await service.listProducts({ status: ProductStatus.INACTIVE }, role);

        const args = prisma.product.findMany.mock.calls[0][0];
        expect(args.where?.status).toBe(ProductStatus.INACTIVE);
      },
    );

    it('oculta internalNotes a SELLER en el listado', async () => {
      prisma.product.findMany.mockResolvedValue([
        makeProductRow({ internalNotes: 'nota secreta' }),
      ]);
      prisma.product.count.mockResolvedValue(1);

      const result = await service.listProducts({}, RoleName.SELLER);

      expect(result.data[0]).not.toHaveProperty('internalNotes');
    });

    it.each([RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT])(
      '%s ve internalNotes en el listado',
      async (role) => {
        prisma.product.findMany.mockResolvedValue([
          makeProductRow({ internalNotes: 'nota interna' }),
        ]);
        prisma.product.count.mockResolvedValue(1);

        const result = await service.listProducts({}, role);

        expect(result.data[0].internalNotes).toBe('nota interna');
      },
    );

    it('salePrice, stockCurrent y stockMinimum salen como string de escala fija', async () => {
      prisma.product.findMany.mockResolvedValue([
        makeProductRow({
          salePrice: new Prisma.Decimal('19.9'),
          stockCurrent: new Prisma.Decimal(0),
          stockMinimum: new Prisma.Decimal('12.5'),
        }),
      ]);
      prisma.product.count.mockResolvedValue(1);

      const result = await service.listProducts({}, RoleName.ADMIN);

      expect(result.data[0].salePrice).toBe('19.90');
      expect(result.data[0].stockCurrent).toBe('0.000');
      expect(result.data[0].stockMinimum).toBe('12.500');
    });
  });

  describe('findProductById', () => {
    it('devuelve el detalle si existe', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProductRow());

      const result = await service.findProductById('product-1', RoleName.ADMIN);

      expect(result.id).toBe('product-1');
    });

    it('lanza NotFoundException si no existe', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        service.findProductById('missing', RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('oculta un producto INACTIVE a SELLER con 404', async () => {
      prisma.product.findUnique.mockResolvedValue(
        makeProductRow({ status: ProductStatus.INACTIVE }),
      );

      await expect(
        service.findProductById('product-1', RoleName.SELLER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT])(
      '%s sí puede ver el detalle de un producto INACTIVE',
      async (role) => {
        prisma.product.findUnique.mockResolvedValue(
          makeProductRow({ status: ProductStatus.INACTIVE }),
        );

        const result = await service.findProductById('product-1', role);

        expect(result.status).toBe(ProductStatus.INACTIVE);
      },
    );

    it('oculta internalNotes a SELLER en el detalle', async () => {
      prisma.product.findUnique.mockResolvedValue(
        makeProductRow({ internalNotes: 'nota secreta' }),
      );

      const result = await service.findProductById(
        'product-1',
        RoleName.SELLER,
      );

      expect(result).not.toHaveProperty('internalNotes');
    });
  });
});
