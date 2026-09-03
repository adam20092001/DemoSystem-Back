import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

const ACTOR: AuthenticatedUser = {
  id: 'actor-id',
  firstName: 'Sonia',
  lastName: 'Seller',
  username: 'seller',
  email: 'seller@demosystem.local',
  role: RoleName.SELLER,
  status: 'ACTIVE',
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const controllerPrototype = ReportsController.prototype as unknown as Record<
  string,
  object
>;

const EXPECTED_ROLES = [RoleName.ADMIN, RoleName.MANAGEMENT, RoleName.SELLER];

function createServiceMock() {
  return {
    salesByProduct: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
    salesByCustomer: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
    salesBySeller: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
    quotesByStatus: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
    paymentsByMethod: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
  };
}

describe('ReportsController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: ReportsController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new ReportsController(service as unknown as ReportsService);
  });

  describe('delegación pura, sin cálculo en el controller', () => {
    it('salesByProduct delega query + rol y devuelve el resultado sin transformar', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      service.salesByProduct.mockResolvedValue(expected);
      const query = { categoryId: 'cat-1' };

      const result = await controller.salesByProduct(query, ACTOR);

      expect(service.salesByProduct).toHaveBeenCalledWith(
        query,
        RoleName.SELLER,
      );
      expect(result).toBe(expected);
    });

    it('salesByCustomer delega query + rol y devuelve el resultado sin transformar', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      service.salesByCustomer.mockResolvedValue(expected);
      const query = { customerType: 'PERSON' };

      const result = await controller.salesByCustomer(query as never, ACTOR);

      expect(service.salesByCustomer).toHaveBeenCalledWith(
        query,
        RoleName.SELLER,
      );
      expect(result).toBe(expected);
    });

    it('salesBySeller delega query + rol y devuelve el resultado sin transformar', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      service.salesBySeller.mockResolvedValue(expected);
      const query = { sellerId: 'seller-1' };

      const result = await controller.salesBySeller(query, ACTOR);

      expect(service.salesBySeller).toHaveBeenCalledWith(
        query,
        RoleName.SELLER,
      );
      expect(result).toBe(expected);
    });

    it('quotesByStatus delega query + rol y devuelve el resultado sin transformar', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      service.quotesByStatus.mockResolvedValue(expected);
      const query = { status: 'CONVERTED' };

      const result = await controller.quotesByStatus(query as never, ACTOR);

      expect(service.quotesByStatus).toHaveBeenCalledWith(
        query,
        RoleName.SELLER,
      );
      expect(result).toBe(expected);
    });

    it('paymentsByMethod delega query + rol y devuelve el resultado sin transformar', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      service.paymentsByMethod.mockResolvedValue(expected);
      const query = { method: 'CASH' };

      const result = await controller.paymentsByMethod(query, ACTOR);

      expect(service.paymentsByMethod).toHaveBeenCalledWith(
        query,
        RoleName.SELLER,
      );
      expect(result).toBe(expected);
    });
  });

  describe('matriz exacta de roles', () => {
    const methods = [
      'salesByProduct',
      'salesByCustomer',
      'salesBySeller',
      'quotesByStatus',
      'paymentsByMethod',
    ];

    it('las 5 rutas exponen @Roles(ADMIN, MANAGEMENT, SELLER) exactamente', () => {
      for (const method of methods) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[method],
        ) as RoleName[];
        expect(metadata).toEqual(EXPECTED_ROLES);
      }
    });

    it('WAREHOUSE no aparece en ninguna de las 5 rutas', () => {
      for (const method of methods) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[method],
        ) as RoleName[];
        expect(metadata).not.toContain(RoleName.WAREHOUSE);
      }
    });
  });

  describe('superficie exacta de rutas', () => {
    it('expone exactamente 5 operaciones GET, sin mutaciones', () => {
      const methodNames = Object.getOwnPropertyNames(
        ReportsController.prototype,
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

      expect(routes).toHaveLength(5);
      expect(routes).toEqual(
        expect.arrayContaining([
          { method: RequestMethod.GET, path: 'sales-by-product' },
          { method: RequestMethod.GET, path: 'sales-by-customer' },
          { method: RequestMethod.GET, path: 'sales-by-seller' },
          { method: RequestMethod.GET, path: 'quotes-by-status' },
          { method: RequestMethod.GET, path: 'payments-by-method' },
        ]),
      );
      expect(routes.some((route) => route.method !== RequestMethod.GET)).toBe(
        false,
      );
    });

    it('no existe ninguna ruta /dashboard ni duplicados de reportes reutilizados', () => {
      const methodNames = Object.getOwnPropertyNames(
        ReportsController.prototype,
      ).filter((name) => name !== 'constructor');
      const paths = methodNames
        .map(
          (name) =>
            Reflect.getMetadata(PATH_METADATA, controllerPrototype[name]) as
              string | undefined,
        )
        .filter((path): path is string => path !== undefined);

      expect(paths).not.toContain('dashboard');
      for (const forbidden of [
        'low-stock',
        'movements',
        'accounts-receivable',
      ]) {
        expect(paths).not.toContain(forbidden);
      }
    });
  });
});
