import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { SaleDocumentRenderer } from './printing/sale-document.renderer';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { SafeSale } from './types/safe-sale';

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

/** Evita que TS trate la referencia como un método enlazable (unbound-method). */
const controllerPrototype = SalesController.prototype as unknown as Record<
  string,
  object
>;

function createServiceMock() {
  return {
    createDirect: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    createFromQuote: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    cancel: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    markDelivered: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    markObserved: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    list: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
    findOne: jest.fn<Promise<unknown>, [string, RoleName]>(),
  };
}

function createRendererMock() {
  return { render: jest.fn<string, [SafeSale]>() };
}

const SAMPLE_SALE = { id: 'sale-1', number: 'NV-000001' };

describe('SalesController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let renderer: ReturnType<typeof createRendererMock>;
  let controller: SalesController;

  beforeEach(() => {
    service = createServiceMock();
    renderer = createRendererMock();
    controller = new SalesController(
      service as unknown as SalesService,
      renderer as unknown as SaleDocumentRenderer,
    );
  });

  describe('create', () => {
    const dto = {
      customerId: 'customer-1',
      items: [{ productId: 'product-1', quantity: '1' }],
    };

    it('delega en service.createDirect con el DTO mapeado, actorUserId y request IP', async () => {
      service.createDirect.mockResolvedValue(SAMPLE_SALE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.create(dto, ACTOR, request);

      expect(service.createDirect).toHaveBeenCalledWith({
        customerId: 'customer-1',
        discountAmount: undefined,
        items: [{ productId: 'product-1', quantity: '1' }],
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(SAMPLE_SALE);
    });

    it('ipAddress ausente en la request se envía como null', async () => {
      service.createDirect.mockResolvedValue(SAMPLE_SALE);
      const request = {} as unknown as Request;

      await controller.create(dto, ACTOR, request);

      expect(service.createDirect).toHaveBeenCalledWith(
        expect.objectContaining({ ipAddress: null }),
      );
    });

    it('propaga discountAmount cuando está presente', async () => {
      service.createDirect.mockResolvedValue(SAMPLE_SALE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      await controller.create(
        { ...dto, discountAmount: '5.00' },
        ACTOR,
        request,
      );

      expect(service.createDirect).toHaveBeenCalledWith(
        expect.objectContaining({ discountAmount: '5.00' }),
      );
    });

    it('sin payment: se delega payment=undefined (Fase 6 preservada)', async () => {
      service.createDirect.mockResolvedValue(SAMPLE_SALE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      await controller.create(dto, ACTOR, request);

      expect(service.createDirect).toHaveBeenCalledWith(
        expect.objectContaining({ payment: undefined }),
      );
    });

    it('con payment: delega method/amount/reference mapeados (Fase 7, Bloque C)', async () => {
      service.createDirect.mockResolvedValue(SAMPLE_SALE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      await controller.create(
        {
          ...dto,
          payment: { method: 'CASH', amount: '10.00', reference: undefined },
        },
        ACTOR,
        request,
      );

      expect(service.createDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          payment: { method: 'CASH', amount: '10.00', reference: undefined },
        }),
      );
    });

    it('el actor autenticado sigue siendo el único origen de actorUserId, incluso con payment presente', async () => {
      service.createDirect.mockResolvedValue(SAMPLE_SALE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      await controller.create(
        { ...dto, payment: { method: 'CASH', amount: '10.00' } },
        ACTOR,
        request,
      );

      expect(service.createDirect).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: 'actor-id' }),
      );
    });
  });

  describe('fromQuote', () => {
    it('sin cuerpo (undefined): delega quoteId + actor/IP, sin payment', async () => {
      service.createFromQuote.mockResolvedValue(SAMPLE_SALE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.fromQuote(
        'quote-1',
        undefined as never,
        ACTOR,
        request,
      );

      expect(service.createFromQuote).toHaveBeenCalledWith({
        quoteId: 'quote-1',
        payment: undefined,
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(SAMPLE_SALE);
    });

    it('cuerpo {} (sin payment): delega sin payment', async () => {
      service.createFromQuote.mockResolvedValue(SAMPLE_SALE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      await controller.fromQuote('quote-1', {}, ACTOR, request);

      expect(service.createFromQuote).toHaveBeenCalledWith(
        expect.objectContaining({ payment: undefined }),
      );
    });

    it('cuerpo con payment: delega method/amount/reference mapeados', async () => {
      service.createFromQuote.mockResolvedValue(SAMPLE_SALE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      await controller.fromQuote(
        'quote-1',
        { payment: { method: 'CASH', amount: '10.00', reference: undefined } },
        ACTOR,
        request,
      );

      expect(service.createFromQuote).toHaveBeenCalledWith({
        quoteId: 'quote-1',
        payment: { method: 'CASH', amount: '10.00', reference: undefined },
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
    });

    it('ipAddress ausente se envía como null', async () => {
      service.createFromQuote.mockResolvedValue(SAMPLE_SALE);
      const request = {} as unknown as Request;

      await controller.fromQuote('quote-1', {}, ACTOR, request);

      expect(service.createFromQuote).toHaveBeenCalledWith(
        expect.objectContaining({ ipAddress: null }),
      );
    });
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
      const query = { search: 'nv-000' };

      const result = await controller.list(query, ACTOR);

      expect(service.list).toHaveBeenCalledWith(query, RoleName.ADMIN);
      expect(result).toBe(expected);
    });
  });

  describe('findOne', () => {
    it('delega el UUID y el rol actual', async () => {
      service.findOne.mockResolvedValue(SAMPLE_SALE);

      const result = await controller.findOne('sale-1', ACTOR);

      expect(service.findOne).toHaveBeenCalledWith('sale-1', RoleName.ADMIN);
      expect(result).toBe(SAMPLE_SALE);
    });
  });

  describe('cancel', () => {
    it('delega id + motivo + actor/IP', async () => {
      service.cancel.mockResolvedValue(SAMPLE_SALE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.cancel(
        'sale-1',
        { reason: 'Cliente se arrepintió' },
        ACTOR,
        request,
      );

      expect(service.cancel).toHaveBeenCalledWith({
        saleId: 'sale-1',
        reason: 'Cliente se arrepintió',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(SAMPLE_SALE);
    });

    it('ipAddress ausente se envía como null', async () => {
      service.cancel.mockResolvedValue(SAMPLE_SALE);
      const request = {} as unknown as Request;

      await controller.cancel('sale-1', { reason: 'motivo' }, ACTOR, request);

      expect(service.cancel).toHaveBeenCalledWith(
        expect.objectContaining({ ipAddress: null }),
      );
    });
  });

  describe('markDelivered', () => {
    it('delega saleId + actor/IP', async () => {
      service.markDelivered.mockResolvedValue(SAMPLE_SALE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.markDelivered('sale-1', ACTOR, request);

      expect(service.markDelivered).toHaveBeenCalledWith({
        saleId: 'sale-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(SAMPLE_SALE);
    });
  });

  describe('markObserved', () => {
    it('delega saleId + actor/IP', async () => {
      service.markObserved.mockResolvedValue(SAMPLE_SALE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.markObserved('sale-1', ACTOR, request);

      expect(service.markObserved).toHaveBeenCalledWith({
        saleId: 'sale-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(SAMPLE_SALE);
    });
  });

  describe('print', () => {
    it('llama a findOne(id, role) y pasa el SafeSale devuelto al renderer', async () => {
      const safeSale = {
        id: 'sale-1',
        number: 'NV-000001',
      } as unknown as SafeSale;
      service.findOne.mockResolvedValue(safeSale);
      renderer.render.mockReturnValue('<html>ok</html>');

      const result = await controller.print('sale-1', ACTOR);

      expect(service.findOne).toHaveBeenCalledWith('sale-1', RoleName.ADMIN);
      expect(renderer.render).toHaveBeenCalledWith(safeSale);
      expect(result).toBe('<html>ok</html>');
    });
  });

  describe('matriz exacta de roles (@Roles por ruta)', () => {
    it.each([
      ['create', [RoleName.ADMIN, RoleName.SELLER]],
      ['fromQuote', [RoleName.ADMIN, RoleName.SELLER]],
      ['list', [RoleName.ADMIN, RoleName.SELLER, RoleName.MANAGEMENT]],
      ['findOne', [RoleName.ADMIN, RoleName.SELLER, RoleName.MANAGEMENT]],
      ['cancel', [RoleName.ADMIN]],
      ['markDelivered', [RoleName.ADMIN, RoleName.SELLER]],
      ['markObserved', [RoleName.ADMIN, RoleName.SELLER]],
      ['print', [RoleName.ADMIN, RoleName.SELLER, RoleName.MANAGEMENT]],
    ])('%s expone @Roles(%p) exactamente', (methodName, roles) => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype[methodName],
      ) as RoleName[];
      expect(metadata).toEqual(roles);
    });

    const ALL_METHODS = [
      'create',
      'fromQuote',
      'list',
      'findOne',
      'cancel',
      'markDelivered',
      'markObserved',
      'print',
    ];

    it('WAREHOUSE no aparece en ninguno de los 8 endpoints', () => {
      for (const methodName of ALL_METHODS) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).not.toContain(RoleName.WAREHOUSE);
      }
    });

    it('ADMIN aparece en los 8 endpoints', () => {
      for (const methodName of ALL_METHODS) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).toContain(RoleName.ADMIN);
      }
    });

    it('SELLER aparece en 7 de los 8 endpoints (todo salvo cancel)', () => {
      const withSeller = [
        'create',
        'fromQuote',
        'list',
        'findOne',
        'markDelivered',
        'markObserved',
        'print',
      ];
      for (const methodName of withSeller) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).toContain(RoleName.SELLER);
      }
      const cancelMetadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype.cancel,
      ) as RoleName[];
      expect(cancelMetadata).not.toContain(RoleName.SELLER);
    });

    it('cancel es exclusivo de ADMIN (ni SELLER ni MANAGEMENT)', () => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype.cancel,
      ) as RoleName[];
      expect(metadata).toEqual([RoleName.ADMIN]);
    });

    it('MANAGEMENT aparece exactamente en list/findOne/print, no en create/fromQuote/cancel/markDelivered/markObserved', () => {
      const withManagement = ['list', 'findOne', 'print'];
      const withoutManagement = [
        'create',
        'fromQuote',
        'cancel',
        'markDelivered',
        'markObserved',
      ];
      for (const methodName of withManagement) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).toContain(RoleName.MANAGEMENT);
      }
      for (const methodName of withoutManagement) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).not.toContain(RoleName.MANAGEMENT);
      }
    });
  });

  describe('superficie exacta de rutas', () => {
    it('expone exactamente 8 operaciones en 7 paths únicos, sin DELETE/PUT/PATCH/Payment', () => {
      const methodNames = Object.getOwnPropertyNames(
        SalesController.prototype,
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
          { method: RequestMethod.POST, path: '/' },
          { method: RequestMethod.POST, path: 'from-quote/:quoteId' },
          { method: RequestMethod.GET, path: '/' },
          { method: RequestMethod.GET, path: ':id' },
          { method: RequestMethod.POST, path: ':id/cancel' },
          { method: RequestMethod.POST, path: ':id/mark-delivered' },
          { method: RequestMethod.POST, path: ':id/mark-observed' },
          { method: RequestMethod.GET, path: ':id/print' },
        ]),
      );

      const uniquePaths = new Set(routes.map((route) => route.path));
      expect(uniquePaths.size).toBe(7);

      expect(
        routes.some((route) => route.method === RequestMethod.DELETE),
      ).toBe(false);
      expect(routes.some((route) => route.method === RequestMethod.PUT)).toBe(
        false,
      );
      expect(routes.some((route) => route.method === RequestMethod.PATCH)).toBe(
        false,
      );
      expect(routes.some((route) => route.path.includes('payment'))).toBe(
        false,
      );
      expect(routes.some((route) => route.path.includes('reopen'))).toBe(false);
    });
  });
});
