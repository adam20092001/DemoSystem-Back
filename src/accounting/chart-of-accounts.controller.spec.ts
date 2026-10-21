import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ChartOfAccountsController } from './chart-of-accounts.controller';
import { ChartOfAccountsService } from './chart-of-accounts.service';

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

const REQUEST = { ip: '10.0.0.1' } as unknown as import('express').Request;

const controllerPrototype =
  ChartOfAccountsController.prototype as unknown as Record<string, object>;

function createServiceMock() {
  return {
    listAccounts: jest.fn(),
    getAccountTree: jest.fn(),
    findAccountById: jest.fn(),
    createAccount: jest.fn(),
    updateAccount: jest.fn(),
    activateAccount: jest.fn(),
    deactivateAccount: jest.fn(),
    reassignSystemKey: jest.fn(),
  };
}

describe('ChartOfAccountsController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: ChartOfAccountsController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new ChartOfAccountsController(
      service as unknown as ChartOfAccountsService,
    );
  });

  describe('delegación', () => {
    it('list delega query + rol actual', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      service.listAccounts.mockResolvedValue(expected);
      const result = await controller.list({ page: 2 }, ACTOR);
      expect(service.listAccounts).toHaveBeenCalledWith(
        { page: 2 },
        RoleName.ADMIN,
      );
      expect(result).toBe(expected);
    });

    it('tree delega solo el rol actual', async () => {
      service.getAccountTree.mockResolvedValue([]);
      await controller.tree(ACTOR);
      expect(service.getAccountTree).toHaveBeenCalledWith(RoleName.ADMIN);
    });

    it('findOne delega id + rol', async () => {
      service.findAccountById.mockResolvedValue({ id: 'a1' });
      await controller.findOne('a1', ACTOR);
      expect(service.findAccountById).toHaveBeenCalledWith(
        'a1',
        RoleName.ADMIN,
      );
    });

    it('create delega el DTO completo más el actor', async () => {
      service.createAccount.mockResolvedValue({ id: 'a1' });
      await controller.create(
        { code: 'X', name: 'X', type: 'ASSET' },
        ACTOR,
        REQUEST,
      );
      expect(service.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'X',
          name: 'X',
          type: 'ASSET',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR.id,
          ipAddress: '10.0.0.1',
        }),
      );
    });

    it('reassignSystemKey delega systemKey del path + accountId del body', async () => {
      service.reassignSystemKey.mockResolvedValue({ id: 'a1' });
      await controller.reassignSystemKey(
        'CASH',
        { accountId: 'a1' },
        ACTOR,
        REQUEST,
      );
      expect(service.reassignSystemKey).toHaveBeenCalledWith(
        expect.objectContaining({
          systemKey: 'CASH',
          targetAccountId: 'a1',
          requesterRole: RoleName.ADMIN,
        }),
      );
    });
  });

  describe('matriz exacta de roles', () => {
    const readRoutes = ['list', 'tree', 'findOne'];
    const mutateRoutes = [
      'create',
      'update',
      'activate',
      'deactivate',
      'reassignSystemKey',
    ];

    it.each(readRoutes)(
      '%s expone @Roles(ADMIN, MANAGEMENT, ACCOUNTANT) exactamente (A4.1: ACCOUNTANT lee el plan de cuentas igual que MANAGEMENT)',
      (name) => {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[name],
        ) as RoleName[];
        expect(metadata).toEqual([
          RoleName.ADMIN,
          RoleName.MANAGEMENT,
          RoleName.ACCOUNTANT,
        ]);
      },
    );

    it.each(mutateRoutes)('%s expone @Roles(ADMIN) exclusivamente', (name) => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype[name],
      ) as RoleName[];
      expect(metadata).toEqual([RoleName.ADMIN]);
    });

    it('ninguna ruta incluye SELLER ni WAREHOUSE', () => {
      for (const name of [...readRoutes, ...mutateRoutes]) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[name],
        ) as RoleName[];
        expect(metadata).not.toContain(RoleName.SELLER);
        expect(metadata).not.toContain(RoleName.WAREHOUSE);
      }
    });
  });

  describe('superficie exacta de rutas', () => {
    it('expone exactamente 8 rutas, con los métodos HTTP esperados', () => {
      const methodNames = Object.getOwnPropertyNames(
        ChartOfAccountsController.prototype,
      ).filter((name) => name !== 'constructor');

      const routes = methodNames
        .map((name) => {
          const handler = controllerPrototype[name];
          const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler) as
            RequestMethod | undefined;
          const path = Reflect.getMetadata(PATH_METADATA, handler) as
            string | undefined;
          if (httpMethod === undefined || path === undefined) {
            return null;
          }
          return { method: httpMethod, path };
        })
        .filter(
          (route): route is { method: RequestMethod; path: string } =>
            route !== null,
        );

      expect(routes).toHaveLength(8);
      expect(routes).toEqual(
        expect.arrayContaining([
          { method: RequestMethod.GET, path: '/' },
          { method: RequestMethod.GET, path: 'tree' },
          { method: RequestMethod.GET, path: ':id' },
          { method: RequestMethod.POST, path: '/' },
          { method: RequestMethod.PATCH, path: ':id' },
          { method: RequestMethod.POST, path: ':id/activate' },
          { method: RequestMethod.POST, path: ':id/deactivate' },
          { method: RequestMethod.PATCH, path: 'system-keys/:systemKey' },
        ]),
      );
    });
  });
});
