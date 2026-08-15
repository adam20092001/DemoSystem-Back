import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AccountsReceivableController } from './accounts-receivable.controller';
import { AccountsReceivableService } from './accounts-receivable.service';

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

const controllerPrototype =
  AccountsReceivableController.prototype as unknown as Record<string, object>;

function createServiceMock() {
  return { list: jest.fn<Promise<unknown>, [unknown, RoleName]>() };
}

describe('AccountsReceivableController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: AccountsReceivableController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new AccountsReceivableController(
      service as unknown as AccountsReceivableService,
    );
  });

  describe('list', () => {
    it('delega la query y el rol actual, y devuelve el resultado sin transformar', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      service.list.mockResolvedValue(expected);
      const query = { customerId: 'customer-1' };

      const result = await controller.list(query, ACTOR);

      expect(service.list).toHaveBeenCalledWith(query, RoleName.ADMIN);
      expect(result).toBe(expected);
    });
  });

  describe('matriz exacta de roles', () => {
    it('list expone @Roles(ADMIN, SELLER, MANAGEMENT) exactamente', () => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype.list,
      ) as RoleName[];
      expect(metadata).toEqual([
        RoleName.ADMIN,
        RoleName.SELLER,
        RoleName.MANAGEMENT,
      ]);
    });

    it('WAREHOUSE no aparece', () => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype.list,
      ) as RoleName[];
      expect(metadata).not.toContain(RoleName.WAREHOUSE);
    });
  });

  describe('superficie exacta de rutas', () => {
    it('expone exactamente 1 operación de solo lectura, sin mutaciones', () => {
      const methodNames = Object.getOwnPropertyNames(
        AccountsReceivableController.prototype,
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

      expect(routes).toHaveLength(1);
      expect(routes[0]).toEqual({ method: RequestMethod.GET, path: '/' });
      expect(routes.some((route) => route.method !== RequestMethod.GET)).toBe(
        false,
      );
    });
  });
});
