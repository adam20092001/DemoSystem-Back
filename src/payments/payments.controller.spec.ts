import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

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
const controllerPrototype = PaymentsController.prototype as unknown as Record<
  string,
  object
>;

function createServiceMock() {
  return {
    register: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    cancel: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    list: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
  };
}

const SAMPLE_RESULT = {
  payment: { id: 'payment-1' },
  sale: { id: 'sale-1', paidAmount: '40.00' },
};

describe('PaymentsController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: PaymentsController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new PaymentsController(service as unknown as PaymentsService);
  });

  describe('register', () => {
    it('delega saleId + method/amount/reference + actor/IP; retorna el resultado del servicio sin transformar', async () => {
      service.register.mockResolvedValue(SAMPLE_RESULT);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.register(
        'sale-1',
        { method: 'CASH', amount: '40.00', reference: undefined } as never,
        ACTOR,
        request,
      );

      expect(service.register).toHaveBeenCalledWith({
        saleId: 'sale-1',
        method: 'CASH',
        amount: '40.00',
        reference: undefined,
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(SAMPLE_RESULT);
    });

    it('propaga reference cuando está presente', async () => {
      service.register.mockResolvedValue(SAMPLE_RESULT);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      await controller.register(
        'sale-1',
        {
          method: 'BANK_TRANSFER',
          amount: '40.00',
          reference: 'OP-000123',
        } as never,
        ACTOR,
        request,
      );

      expect(service.register).toHaveBeenCalledWith(
        expect.objectContaining({ reference: 'OP-000123' }),
      );
    });

    it('ipAddress ausente se envía como null', async () => {
      service.register.mockResolvedValue(SAMPLE_RESULT);
      const request = {} as unknown as Request;

      await controller.register(
        'sale-1',
        { method: 'CASH', amount: '40.00' } as never,
        ACTOR,
        request,
      );

      expect(service.register).toHaveBeenCalledWith(
        expect.objectContaining({ ipAddress: null }),
      );
    });

    it('el controller nunca calcula el resumen de pago (no toca paidAmount/balanceDue/paymentStatus)', async () => {
      service.register.mockResolvedValue(SAMPLE_RESULT);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      await controller.register(
        'sale-1',
        { method: 'CASH', amount: '40.00' } as never,
        ACTOR,
        request,
      );

      const call = service.register.mock.calls[0][0];
      expect(call).not.toHaveProperty('paidAmount');
      expect(call).not.toHaveProperty('balanceDue');
      expect(call).not.toHaveProperty('paymentStatus');
    });
  });

  describe('cancel', () => {
    it('delega saleId + paymentId + motivo + actor/IP', async () => {
      service.cancel.mockResolvedValue(SAMPLE_RESULT);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.cancel(
        'sale-1',
        'payment-1',
        { reason: 'Pago registrado por error' },
        ACTOR,
        request,
      );

      expect(service.cancel).toHaveBeenCalledWith({
        saleId: 'sale-1',
        paymentId: 'payment-1',
        reason: 'Pago registrado por error',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(SAMPLE_RESULT);
    });

    it('ipAddress ausente se envía como null', async () => {
      service.cancel.mockResolvedValue(SAMPLE_RESULT);
      const request = {} as unknown as Request;

      await controller.cancel(
        'sale-1',
        'payment-1',
        { reason: 'motivo' },
        ACTOR,
        request,
      );

      expect(service.cancel).toHaveBeenCalledWith(
        expect.objectContaining({ ipAddress: null }),
      );
    });

    it('no acepta un cancellationSource del cliente (el DTO no tiene ese campo)', async () => {
      service.cancel.mockResolvedValue(SAMPLE_RESULT);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      await controller.cancel(
        'sale-1',
        'payment-1',
        { reason: 'motivo' },
        ACTOR,
        request,
      );

      const call = service.cancel.mock.calls[0][0];
      expect(call).not.toHaveProperty('cancellationSource');
      expect(call).not.toHaveProperty('source');
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
      const query = { method: 'CASH' };

      const result = await controller.list(query as never, ACTOR);

      expect(service.list).toHaveBeenCalledWith(query, RoleName.ADMIN);
      expect(result).toBe(expected);
    });
  });

  describe('matriz exacta de roles (@Roles por ruta)', () => {
    it.each([
      ['register', [RoleName.ADMIN, RoleName.SELLER]],
      ['cancel', [RoleName.ADMIN]],
      ['list', [RoleName.ADMIN, RoleName.SELLER, RoleName.MANAGEMENT]],
    ])('%s expone @Roles(%p) exactamente', (methodName, roles) => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype[methodName],
      ) as RoleName[];
      expect(metadata).toEqual(roles);
    });

    it('WAREHOUSE no aparece en ninguna de las 3 operaciones', () => {
      for (const methodName of ['register', 'cancel', 'list']) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).not.toContain(RoleName.WAREHOUSE);
      }
    });

    it('cancel es exclusivo de ADMIN (ni SELLER ni MANAGEMENT)', () => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype.cancel,
      ) as RoleName[];
      expect(metadata).toEqual([RoleName.ADMIN]);
    });
  });

  describe('superficie exacta de rutas', () => {
    it('expone exactamente 3 operaciones, sin GET :id/PATCH/PUT/DELETE/receipt/print', () => {
      const methodNames = Object.getOwnPropertyNames(
        PaymentsController.prototype,
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

      expect(routes).toHaveLength(3);
      expect(routes).toEqual(
        expect.arrayContaining([
          { method: RequestMethod.POST, path: 'sales/:saleId/payments' },
          {
            method: RequestMethod.POST,
            path: 'sales/:saleId/payments/:paymentId/cancel',
          },
          { method: RequestMethod.GET, path: 'payments' },
        ]),
      );

      expect(
        routes.some((route) => route.method === RequestMethod.DELETE),
      ).toBe(false);
      expect(routes.some((route) => route.method === RequestMethod.PUT)).toBe(
        false,
      );
      expect(routes.some((route) => route.method === RequestMethod.PATCH)).toBe(
        false,
      );
      expect(
        routes.some(
          (route) =>
            route.method === RequestMethod.GET &&
            route.path.includes(':paymentId') &&
            !route.path.includes('cancel'),
        ),
      ).toBe(false);
    });
  });
});
