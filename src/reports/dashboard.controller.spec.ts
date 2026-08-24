import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

const ACTOR: AuthenticatedUser = {
  id: 'actor-id',
  firstName: 'Wendy',
  lastName: 'Warehouse',
  username: 'warehouse',
  email: 'warehouse@demosystem.local',
  role: RoleName.WAREHOUSE,
  status: 'ACTIVE',
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const controllerPrototype = DashboardController.prototype as unknown as Record<
  string,
  object
>;

const EXPECTED_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.SELLER,
  RoleName.WAREHOUSE,
];

function createServiceMock() {
  return {
    getDashboard: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
  };
}

describe('DashboardController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: DashboardController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new DashboardController(
      service as unknown as DashboardService,
    );
  });

  describe('delegación pura, sin cálculo en el controller', () => {
    it('delega query + rol y devuelve el resultado sin transformar', async () => {
      const expected = {
        period: { from: '2026-08-01', to: '2026-08-23' },
        sales: null,
        collections: null,
        lowStock: { count: 0, items: [] },
        quotes: null,
        receivables: null,
      };
      service.getDashboard.mockResolvedValue(expected);
      const query = { from: '2026-08-01', to: '2026-08-23' };

      const result = await controller.getDashboard(query, ACTOR);

      expect(service.getDashboard).toHaveBeenCalledWith(
        query,
        RoleName.WAREHOUSE,
      );
      expect(result).toBe(expected);
    });

    it('sin query: se delega tal cual (el default de período lo resuelve el servicio)', async () => {
      const expected = {
        period: { from: '2026-08-01', to: '2026-08-23' },
        sales: null,
        collections: null,
        lowStock: null,
        quotes: null,
        receivables: null,
      };
      service.getDashboard.mockResolvedValue(expected);

      const result = await controller.getDashboard({}, ACTOR);

      expect(service.getDashboard).toHaveBeenCalledWith({}, RoleName.WAREHOUSE);
      expect(result).toBe(expected);
    });
  });

  describe('matriz exacta de roles', () => {
    it('expone @Roles(ADMIN, MANAGEMENT, SELLER, WAREHOUSE) exactamente', () => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype.getDashboard,
      ) as RoleName[];
      expect(metadata).toEqual(EXPECTED_ROLES);
    });
  });

  describe('superficie exacta de rutas', () => {
    it('expone exactamente 1 operación GET, sin mutaciones', () => {
      const methodNames = Object.getOwnPropertyNames(
        DashboardController.prototype,
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
    });

    it('no existe ninguna ruta /dashboard/summary|sales|payments|inventory|quotes|receivables', () => {
      const methodNames = Object.getOwnPropertyNames(
        DashboardController.prototype,
      ).filter((name) => name !== 'constructor');
      const paths = methodNames
        .map(
          (name) =>
            Reflect.getMetadata(PATH_METADATA, controllerPrototype[name]) as
              string | undefined,
        )
        .filter((path): path is string => path !== undefined);

      for (const forbidden of [
        'summary',
        'sales',
        'payments',
        'inventory',
        'quotes',
        'receivables',
      ]) {
        expect(paths).not.toContain(forbidden);
      }
    });
  });
});
