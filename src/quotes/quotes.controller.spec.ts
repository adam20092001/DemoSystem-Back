import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { QuoteDocumentRenderer } from './printing/quote-document.renderer';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { SafeQuote } from './types/safe-quote';

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
const controllerPrototype = QuotesController.prototype as unknown as Record<
  string,
  object
>;

function createServiceMock() {
  return {
    create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    update: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    accept: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    reject: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    list: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
    findOne: jest.fn<Promise<unknown>, [string, RoleName]>(),
  };
}

function createRendererMock() {
  return { render: jest.fn<string, [SafeQuote]>() };
}

const SAMPLE_QUOTE = { id: 'quote-1', number: 'COT-000001' };

describe('QuotesController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let renderer: ReturnType<typeof createRendererMock>;
  let controller: QuotesController;

  beforeEach(() => {
    service = createServiceMock();
    renderer = createRendererMock();
    controller = new QuotesController(
      service as unknown as QuotesService,
      renderer as unknown as QuoteDocumentRenderer,
    );
  });

  describe('create', () => {
    const dto = {
      customerId: 'customer-1',
      expirationDate: '2026-04-15',
      items: [{ productId: 'product-1', quantity: '1' }],
    };

    it('delega en service.create con el DTO mapeado, actorUserId y request IP', async () => {
      service.create.mockResolvedValue(SAMPLE_QUOTE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.create(dto, ACTOR, request);

      expect(service.create).toHaveBeenCalledWith({
        customerId: 'customer-1',
        expirationDate: '2026-04-15',
        discountAmount: undefined,
        notes: undefined,
        items: [{ productId: 'product-1', quantity: '1' }],
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(SAMPLE_QUOTE);
    });

    it('ipAddress ausente en la request se envía como null', async () => {
      service.create.mockResolvedValue(SAMPLE_QUOTE);
      const request = {} as unknown as Request;

      await controller.create(dto, ACTOR, request);

      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({ ipAddress: null }),
      );
    });

    it('propaga discountAmount/notes cuando están presentes', async () => {
      service.create.mockResolvedValue(SAMPLE_QUOTE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      await controller.create(
        { ...dto, discountAmount: '5.00', notes: 'Nota' },
        ACTOR,
        request,
      );

      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({ discountAmount: '5.00', notes: 'Nota' }),
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
      const query = { search: 'juan' };

      const result = await controller.list(query, ACTOR);

      expect(service.list).toHaveBeenCalledWith(query, RoleName.ADMIN);
      expect(result).toBe(expected);
    });
  });

  describe('findOne', () => {
    it('delega el UUID y el rol actual', async () => {
      service.findOne.mockResolvedValue(SAMPLE_QUOTE);

      const result = await controller.findOne('quote-1', ACTOR);

      expect(service.findOne).toHaveBeenCalledWith('quote-1', RoleName.ADMIN);
      expect(result).toBe(SAMPLE_QUOTE);
    });
  });

  describe('update', () => {
    it('delega id + DTO mapeado + actor/IP', async () => {
      service.update.mockResolvedValue(SAMPLE_QUOTE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.update(
        'quote-1',
        { notes: 'Actualizada' },
        ACTOR,
        request,
      );

      expect(service.update).toHaveBeenCalledWith({
        quoteId: 'quote-1',
        expirationDate: undefined,
        discountAmount: undefined,
        notes: 'Actualizada',
        items: undefined,
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(SAMPLE_QUOTE);
    });

    it('mapea items cuando están presentes', async () => {
      service.update.mockResolvedValue(SAMPLE_QUOTE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      await controller.update(
        'quote-1',
        { items: [{ productId: 'product-1', quantity: '2' }] },
        ACTOR,
        request,
      );

      expect(service.update).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [{ productId: 'product-1', quantity: '2' }],
        }),
      );
    });
  });

  describe('accept', () => {
    it('delega quoteId + actor/IP', async () => {
      service.accept.mockResolvedValue(SAMPLE_QUOTE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.accept('quote-1', ACTOR, request);

      expect(service.accept).toHaveBeenCalledWith({
        quoteId: 'quote-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(SAMPLE_QUOTE);
    });
  });

  describe('reject', () => {
    it('delega quoteId + actor/IP', async () => {
      service.reject.mockResolvedValue(SAMPLE_QUOTE);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.reject('quote-1', ACTOR, request);

      expect(service.reject).toHaveBeenCalledWith({
        quoteId: 'quote-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(SAMPLE_QUOTE);
    });
  });

  describe('print', () => {
    it('llama a findOne(id, role) y pasa el SafeQuote devuelto al renderer', async () => {
      const safeQuote = {
        id: 'quote-1',
        number: 'COT-000001',
      } as unknown as SafeQuote;
      service.findOne.mockResolvedValue(safeQuote);
      renderer.render.mockReturnValue('<html>ok</html>');

      const result = await controller.print('quote-1', ACTOR);

      expect(service.findOne).toHaveBeenCalledWith('quote-1', RoleName.ADMIN);
      expect(renderer.render).toHaveBeenCalledWith(safeQuote);
      expect(result).toBe('<html>ok</html>');
    });
  });

  describe('matriz exacta de roles (@Roles por ruta)', () => {
    it.each([
      ['create', [RoleName.ADMIN, RoleName.SELLER]],
      ['list', [RoleName.ADMIN, RoleName.SELLER, RoleName.MANAGEMENT]],
      ['findOne', [RoleName.ADMIN, RoleName.SELLER, RoleName.MANAGEMENT]],
      ['update', [RoleName.ADMIN, RoleName.SELLER]],
      ['accept', [RoleName.ADMIN, RoleName.SELLER]],
      ['reject', [RoleName.ADMIN, RoleName.SELLER]],
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
      'list',
      'findOne',
      'update',
      'accept',
      'reject',
      'print',
    ];

    it('WAREHOUSE no aparece en ninguno de los 7 endpoints', () => {
      for (const methodName of ALL_METHODS) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).not.toContain(RoleName.WAREHOUSE);
      }
    });

    it('ADMIN aparece en los 7 endpoints', () => {
      for (const methodName of ALL_METHODS) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).toContain(RoleName.ADMIN);
      }
    });

    it('SELLER aparece en los 7 endpoints (acceso Total, D9)', () => {
      for (const methodName of ALL_METHODS) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).toContain(RoleName.SELLER);
      }
    });

    it('MANAGEMENT aparece exactamente en list/findOne/print, no en create/update/accept/reject', () => {
      const withManagement = ['list', 'findOne', 'print'];
      const withoutManagement = ['create', 'update', 'accept', 'reject'];
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
    it('expone exactamente 7 operaciones en 5 paths únicos, sin DELETE/PUT/conversión', () => {
      const methodNames = Object.getOwnPropertyNames(
        QuotesController.prototype,
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

      expect(routes).toHaveLength(7);
      expect(routes).toEqual(
        expect.arrayContaining([
          { method: RequestMethod.POST, path: '/' },
          { method: RequestMethod.GET, path: '/' },
          { method: RequestMethod.GET, path: ':id' },
          { method: RequestMethod.PATCH, path: ':id' },
          { method: RequestMethod.POST, path: ':id/accept' },
          { method: RequestMethod.POST, path: ':id/reject' },
          { method: RequestMethod.GET, path: ':id/print' },
        ]),
      );

      const uniquePaths = new Set(routes.map((route) => route.path));
      expect(uniquePaths.size).toBe(5);

      expect(
        routes.some((route) => route.method === RequestMethod.DELETE),
      ).toBe(false);
      expect(routes.some((route) => route.method === RequestMethod.PUT)).toBe(
        false,
      );
      expect(routes.some((route) => route.path.includes('convert'))).toBe(
        false,
      );
      expect(routes.some((route) => route.path.includes('expire'))).toBe(false);
    });
  });
});
