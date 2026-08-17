import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AccountsController } from './accounts.controller';
import { AccountingService } from './accounting.service';

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

const controllerPrototype = AccountsController.prototype as unknown as Record<
  string,
  object
>;

function createServiceMock() {
  return { listAccounts: jest.fn<Promise<unknown>, [RoleName]>() };
}

describe('AccountsController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: AccountsController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new AccountsController(
      service as unknown as AccountingService,
    );
  });

  describe('list', () => {
    it('delega el rol actual, y devuelve el resultado sin transformar', async () => {
      const expected = [{ id: 'account-1', code: 'AR' }];
      service.listAccounts.mockResolvedValue(expected);

      const result = await controller.list(ACTOR);

      expect(service.listAccounts).toHaveBeenCalledWith(RoleName.ADMIN);
      expect(result).toBe(expected);
    });
  });

  describe('matriz exacta de roles', () => {
    it('list expone @Roles(ADMIN, MANAGEMENT) exactamente', () => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype.list,
      ) as RoleName[];
      expect(metadata).toEqual([RoleName.ADMIN, RoleName.MANAGEMENT]);
    });

    it('SELLER y WAREHOUSE no aparecen', () => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype.list,
      ) as RoleName[];
      expect(metadata).not.toContain(RoleName.SELLER);
      expect(metadata).not.toContain(RoleName.WAREHOUSE);
    });
  });

  describe('superficie exacta de rutas', () => {
    it('expone exactamente 1 operación de solo lectura, sin mutaciones', () => {
      const methodNames = Object.getOwnPropertyNames(
        AccountsController.prototype,
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
