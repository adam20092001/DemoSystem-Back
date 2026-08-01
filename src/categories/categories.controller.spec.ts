import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

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

function createServiceMock() {
  return {
    createCategory: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    updateCategory: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    activateCategory: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    deactivateCategory: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    listCategories: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
    findCategoryById: jest.fn<Promise<unknown>, [string, RoleName]>(),
  };
}

describe('CategoriesController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: CategoriesController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new CategoriesController(
      service as unknown as CategoriesService,
    );
  });

  it('create() toma actorUserId de @CurrentUser() e ipAddress de la request', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.create({ code: 'X', name: 'X' }, ACTOR, request);

    expect(service.createCategory).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      }),
    );
  });

  it('update() propaga actorUserId e ipAddress', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.update('cat-1', { name: 'Y' }, ACTOR, request);

    expect(service.updateCategory).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: 'cat-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      }),
    );
  });

  it('activate() e ipAddress ausente en la request se envía como null', async () => {
    const request = {} as unknown as Request;

    await controller.activate('cat-1', ACTOR, request);

    expect(service.activateCategory).toHaveBeenCalledWith({
      categoryId: 'cat-1',
      actorUserId: 'actor-id',
      ipAddress: null,
    });
  });

  it('deactivate() propaga actorUserId e ipAddress', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.deactivate('cat-1', ACTOR, request);

    expect(service.deactivateCategory).toHaveBeenCalledWith({
      categoryId: 'cat-1',
      actorUserId: 'actor-id',
      ipAddress: '203.0.113.5',
    });
  });

  it('list() pasa el rol del solicitante al servicio', async () => {
    await controller.list({}, ACTOR);

    expect(service.listCategories).toHaveBeenCalledWith({}, RoleName.ADMIN);
  });

  it('findOne() pasa el rol del solicitante al servicio', async () => {
    await controller.findOne('cat-1', ACTOR);

    expect(service.findCategoryById).toHaveBeenCalledWith(
      'cat-1',
      RoleName.ADMIN,
    );
  });
});
