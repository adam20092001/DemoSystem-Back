import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AccountingEntriesController } from './accounting-entries.controller';
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

const controllerPrototype =
  AccountingEntriesController.prototype as unknown as Record<string, object>;

function createServiceMock() {
  return {
    listEntries: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
    findEntry: jest.fn<Promise<unknown>, [string, RoleName]>(),
  };
}

describe('AccountingEntriesController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: AccountingEntriesController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new AccountingEntriesController(
      service as unknown as AccountingService,
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
      service.listEntries.mockResolvedValue(expected);
      const query = { sourceType: 'SALE' };

      const result = await controller.list(query as never, ACTOR);

      expect(service.listEntries).toHaveBeenCalledWith(query, RoleName.ADMIN);
      expect(result).toBe(expected);
    });
  });

  describe('findOne', () => {
    it('delega id y rol actual, y devuelve el resultado sin transformar', async () => {
      const expected = { id: 'entry-1', lines: [] };
      service.findEntry.mockResolvedValue(expected);

      const result = await controller.findOne('entry-1', ACTOR);

      expect(service.findEntry).toHaveBeenCalledWith('entry-1', RoleName.ADMIN);
      expect(result).toBe(expected);
    });
  });

  describe('matriz exacta de roles', () => {
    it('list y findOne exponen @Roles(ADMIN, MANAGEMENT) exactamente', () => {
      for (const method of ['list', 'findOne']) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[method],
        ) as RoleName[];
        expect(metadata).toEqual([RoleName.ADMIN, RoleName.MANAGEMENT]);
      }
    });

    it('SELLER y WAREHOUSE no aparecen', () => {
      for (const method of ['list', 'findOne']) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[method],
        ) as RoleName[];
        expect(metadata).not.toContain(RoleName.SELLER);
        expect(metadata).not.toContain(RoleName.WAREHOUSE);
      }
    });
  });

  describe('superficie exacta de rutas', () => {
    it('expone exactamente 2 operaciones de solo lectura, sin mutaciones', () => {
      const methodNames = Object.getOwnPropertyNames(
        AccountingEntriesController.prototype,
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

      expect(routes).toHaveLength(2);
      expect(routes).toEqual(
        expect.arrayContaining([
          { method: RequestMethod.GET, path: '/' },
          { method: RequestMethod.GET, path: ':id' },
        ]),
      );
      expect(routes.some((route) => route.method !== RequestMethod.GET)).toBe(
        false,
      );
    });
  });
});
