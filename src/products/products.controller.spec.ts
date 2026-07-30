import { ProductType, RoleName } from '@prisma/client';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ProductSpecificationsService } from './product-specifications.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

const ACTOR: AuthenticatedUser = {
  id: 'actor-id',
  firstName: 'Ana',
  lastName: 'Admin',
  username: 'admin',
  email: 'admin@demosystem.local',
  role: RoleName.ADMIN,
  status: 'ACTIVE',
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createProductsServiceMock() {
  return {
    createProduct: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    updateProduct: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    activateProduct: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    deactivateProduct: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    listProducts: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
    findProductById: jest.fn<Promise<unknown>, [string, RoleName]>(),
  };
}

function createSpecificationsServiceMock() {
  return {
    createSpecification: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    updateSpecification: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    deleteSpecification: jest.fn<Promise<void>, [Record<string, unknown>]>(),
  };
}

describe('ProductsController', () => {
  let productsService: ReturnType<typeof createProductsServiceMock>;
  let specificationsService: ReturnType<typeof createSpecificationsServiceMock>;
  let controller: ProductsController;

  beforeEach(() => {
    productsService = createProductsServiceMock();
    specificationsService = createSpecificationsServiceMock();
    controller = new ProductsController(
      productsService as unknown as ProductsService,
      specificationsService as unknown as ProductSpecificationsService,
    );
  });

  it('list() pasa el rol del solicitante al servicio', async () => {
    await controller.list({}, ACTOR);

    expect(productsService.listProducts).toHaveBeenCalledWith(
      {},
      RoleName.ADMIN,
    );
  });

  it('findOne() pasa el rol del solicitante al servicio', async () => {
    await controller.findOne('product-1', ACTOR);

    expect(productsService.findProductById).toHaveBeenCalledWith(
      'product-1',
      RoleName.ADMIN,
    );
  });

  it('create() toma actorUserId de @CurrentUser() e ipAddress de la request', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.create(
      {
        sku: 'SKU-1',
        name: 'Producto',
        productType: ProductType.PRODUCT,
        categoryId: 'category-1',
        unitId: 'unit-1',
        salePrice: '10.00',
        isInventoryTracked: true,
      },
      ACTOR,
      request,
    );

    expect(productsService.createProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      }),
    );
  });

  it('create() con ipAddress ausente en la request se envía como null', async () => {
    const request = {} as unknown as Request;

    await controller.create(
      {
        sku: 'SKU-1',
        name: 'Producto',
        productType: ProductType.PRODUCT,
        categoryId: 'category-1',
        unitId: 'unit-1',
        salePrice: '10.00',
        isInventoryTracked: true,
      },
      ACTOR,
      request,
    );

    expect(productsService.createProduct).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: null }),
    );
  });

  it('update() propaga actorUserId e ipAddress', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.update('product-1', { name: 'Nuevo' }, ACTOR, request);

    expect(productsService.updateProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'product-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      }),
    );
  });

  it('activate() propaga actorUserId e ipAddress', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.activate('product-1', ACTOR, request);

    expect(productsService.activateProduct).toHaveBeenCalledWith({
      productId: 'product-1',
      actorUserId: 'actor-id',
      ipAddress: '203.0.113.5',
    });
  });

  it('deactivate() propaga actorUserId e ipAddress', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.deactivate('product-1', ACTOR, request);

    expect(productsService.deactivateProduct).toHaveBeenCalledWith({
      productId: 'product-1',
      actorUserId: 'actor-id',
      ipAddress: '203.0.113.5',
    });
  });

  it('createSpecification() delega en ProductSpecificationsService con productId de la ruta', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.createSpecification(
      'product-1',
      { name: 'Color', value: 'Rojo' },
      ACTOR,
      request,
    );

    expect(specificationsService.createSpecification).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'product-1',
        name: 'Color',
        value: 'Rojo',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      }),
    );
  });

  it('updateSpecification() delega en ProductSpecificationsService con productId y specificationId de la ruta', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.updateSpecification(
      'product-1',
      'spec-1',
      { value: 'Azul' },
      ACTOR,
      request,
    );

    expect(specificationsService.updateSpecification).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'product-1',
        specificationId: 'spec-1',
        value: 'Azul',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      }),
    );
  });

  it('deleteSpecification() delega en ProductSpecificationsService y no devuelve cuerpo (204)', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    const result = await controller.deleteSpecification(
      'product-1',
      'spec-1',
      ACTOR,
      request,
    );

    expect(result).toBeUndefined();
    expect(specificationsService.deleteSpecification).toHaveBeenCalledWith({
      productId: 'product-1',
      specificationId: 'spec-1',
      actorUserId: 'actor-id',
      ipAddress: '203.0.113.5',
    });
  });
});
