import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CashSessionsController } from './cash-sessions.controller';
import { CashSessionsService } from './cash-sessions.service';

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

const controllerPrototype =
  CashSessionsController.prototype as unknown as Record<string, object>;

function createServiceMock() {
  return {
    open: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    getCurrent: jest.fn<Promise<unknown>, [unknown]>(),
    list: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    getDetail: jest.fn<Promise<unknown>, [string, unknown]>(),
  };
}

const SAMPLE_SESSION = { id: 'cs-1', status: 'OPEN' };

describe('CashSessionsController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: CashSessionsController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new CashSessionsController(
      service as unknown as CashSessionsService,
    );
  });

  describe('open', () => {
    it('delega openingAmount + actor/IP; retorna el resultado del servicio sin transformar', async () => {
      service.open.mockResolvedValue(SAMPLE_SESSION);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.open(
        { openingAmount: '100.00' },
        ACTOR,
        request,
      );

      expect(service.open).toHaveBeenCalledWith({
        openingAmount: '100.00',
        requesterRole: RoleName.SELLER,
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(SAMPLE_SESSION);
    });

    it('ipAddress ausente se envía como null', async () => {
      service.open.mockResolvedValue(SAMPLE_SESSION);
      const request = {} as unknown as Request;

      await controller.open({ openingAmount: '0' }, ACTOR, request);

      expect(service.open).toHaveBeenCalledWith(
        expect.objectContaining({ ipAddress: null }),
      );
    });
  });

  describe('getCurrent', () => {
    it('delega el actor y devuelve el resultado sin transformar', async () => {
      service.getCurrent.mockResolvedValue(SAMPLE_SESSION);
      const result = await controller.getCurrent(ACTOR);
      expect(service.getCurrent).toHaveBeenCalledWith(ACTOR);
      expect(result).toBe(SAMPLE_SESSION);
    });
  });

  describe('list', () => {
    it('delega la query y el actor, y devuelve el resultado sin transformar', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      service.list.mockResolvedValue(expected);
      const query = { status: 'OPEN' };

      const result = await controller.list(query, ACTOR);

      expect(service.list).toHaveBeenCalledWith(query, ACTOR);
      expect(result).toBe(expected);
    });
  });

  describe('getDetail', () => {
    it('delega id + actor, y devuelve el resultado sin transformar', async () => {
      service.getDetail.mockResolvedValue(SAMPLE_SESSION);
      const result = await controller.getDetail('cs-1', ACTOR);
      expect(service.getDetail).toHaveBeenCalledWith('cs-1', ACTOR);
      expect(result).toBe(SAMPLE_SESSION);
    });
  });

  describe('matriz exacta de roles (@Roles por ruta)', () => {
    it.each([
      ['open', [RoleName.ADMIN, RoleName.SELLER]],
      ['getCurrent', [RoleName.ADMIN, RoleName.SELLER]],
      ['list', [RoleName.ADMIN, RoleName.MANAGEMENT, RoleName.SELLER]],
      ['getDetail', [RoleName.ADMIN, RoleName.MANAGEMENT, RoleName.SELLER]],
    ])('%s expone @Roles(%p) exactamente', (methodName, roles) => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype[methodName],
      ) as RoleName[];
      expect(metadata).toEqual(roles);
    });

    it('WAREHOUSE no aparece en ninguna de las 4 operaciones', () => {
      for (const methodName of ['open', 'getCurrent', 'list', 'getDetail']) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).not.toContain(RoleName.WAREHOUSE);
      }
    });

    it('MANAGEMENT no aparece en open/getCurrent (no cobra, no abre caja)', () => {
      for (const methodName of ['open', 'getCurrent']) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).not.toContain(RoleName.MANAGEMENT);
      }
    });
  });

  describe('superficie exacta de rutas', () => {
    it('expone exactamente 4 operaciones: POST open, GET current, GET (list), GET :id', () => {
      const methodNames = Object.getOwnPropertyNames(
        CashSessionsController.prototype,
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

      expect(routes).toHaveLength(4);
      expect(routes).toEqual(
        expect.arrayContaining([
          { method: RequestMethod.POST, path: 'open' },
          { method: RequestMethod.GET, path: 'current' },
          { method: RequestMethod.GET, path: '/' },
          { method: RequestMethod.GET, path: ':id' },
        ]),
      );
      expect(
        routes.some(
          (route) =>
            route.method === RequestMethod.POST &&
            (route.path.includes('close') ||
              route.path.includes('approve') ||
              route.path.includes('reject')),
        ),
      ).toBe(false);
    });
  });
});
