import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import {
  CustomerStage,
  CustomerStatus,
  CustomerType,
  RoleName,
} from '@prisma/client';
import type { Request } from 'express';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

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
const controllerPrototype = CustomersController.prototype as unknown as Record<
  string,
  object
>;

function createServiceMock() {
  return {
    create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    list: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
    findOne: jest.fn<Promise<unknown>, [string, RoleName]>(),
    update: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    activate: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    deactivate: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    block: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    unblock: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    convertToCustomer: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
  };
}

describe('CustomersController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: CustomersController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new CustomersController(
      service as unknown as CustomersService,
    );
  });

  describe('create', () => {
    const dto = {
      customerType: CustomerType.PERSON,
      customerStage: CustomerStage.PROSPECT,
      name: 'Cliente Uno',
    };

    it('delega en service.create con el DTO, actorUserId y request IP', async () => {
      const expected = { id: 'customer-1' };
      service.create.mockResolvedValue(expected);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.create(dto, ACTOR, request);

      expect(service.create).toHaveBeenCalledWith({
        customerType: CustomerType.PERSON,
        customerStage: CustomerStage.PROSPECT,
        name: 'Cliente Uno',
        documentType: undefined,
        documentNumber: undefined,
        tradeName: undefined,
        contactName: undefined,
        email: undefined,
        phone: undefined,
        address: undefined,
        internalNotes: undefined,
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });

    it('ipAddress ausente en la request se envía como null', async () => {
      service.create.mockResolvedValue({});
      const request = {} as unknown as Request;

      await controller.create(dto, ACTOR, request);

      expect(service.create).toHaveBeenCalledWith(
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
      const query = { search: 'juan' };

      const result = await controller.list(query, ACTOR);

      expect(service.list).toHaveBeenCalledWith(query, RoleName.ADMIN);
      expect(result).toBe(expected);
    });
  });

  describe('findOne', () => {
    it('delega el UUID y el rol actual', async () => {
      const expected = { id: 'customer-1' };
      service.findOne.mockResolvedValue(expected);

      const result = await controller.findOne('customer-1', ACTOR);

      expect(service.findOne).toHaveBeenCalledWith(
        'customer-1',
        RoleName.ADMIN,
      );
      expect(result).toBe(expected);
    });
  });

  describe('update', () => {
    it('delega id + DTO + actor/IP', async () => {
      const expected = { id: 'customer-1' };
      service.update.mockResolvedValue(expected);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.update(
        'customer-1',
        { phone: '999999999' },
        ACTOR,
        request,
      );

      expect(service.update).toHaveBeenCalledWith({
        customerId: 'customer-1',
        name: undefined,
        documentType: undefined,
        documentNumber: undefined,
        tradeName: undefined,
        contactName: undefined,
        email: undefined,
        phone: '999999999',
        address: undefined,
        internalNotes: undefined,
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });
  });

  describe('activate', () => {
    it('delega customerId + actor/IP', async () => {
      const expected = { id: 'customer-1', status: CustomerStatus.ACTIVE };
      service.activate.mockResolvedValue(expected);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.activate('customer-1', ACTOR, request);

      expect(service.activate).toHaveBeenCalledWith({
        customerId: 'customer-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });
  });

  describe('deactivate', () => {
    it('delega customerId + actor/IP', async () => {
      const expected = { id: 'customer-1', status: CustomerStatus.INACTIVE };
      service.deactivate.mockResolvedValue(expected);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.deactivate('customer-1', ACTOR, request);

      expect(service.deactivate).toHaveBeenCalledWith({
        customerId: 'customer-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });
  });

  describe('block', () => {
    it('delega customerId + actor/IP', async () => {
      const expected = { id: 'customer-1', status: CustomerStatus.BLOCKED };
      service.block.mockResolvedValue(expected);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.block('customer-1', ACTOR, request);

      expect(service.block).toHaveBeenCalledWith({
        customerId: 'customer-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });
  });

  describe('unblock', () => {
    it('delega customerId + actor/IP', async () => {
      const expected = { id: 'customer-1', status: CustomerStatus.ACTIVE };
      service.unblock.mockResolvedValue(expected);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.unblock('customer-1', ACTOR, request);

      expect(service.unblock).toHaveBeenCalledWith({
        customerId: 'customer-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });
  });

  describe('convertToCustomer', () => {
    it('delega customerId + actor/IP', async () => {
      const expected = {
        id: 'customer-1',
        customerStage: CustomerStage.CUSTOMER,
      };
      service.convertToCustomer.mockResolvedValue(expected);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.convertToCustomer(
        'customer-1',
        ACTOR,
        request,
      );

      expect(service.convertToCustomer).toHaveBeenCalledWith({
        customerId: 'customer-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });
  });

  describe('matriz exacta de roles (@Roles por ruta)', () => {
    it.each([
      ['create', [RoleName.ADMIN, RoleName.SELLER]],
      ['list', [RoleName.ADMIN, RoleName.SELLER, RoleName.MANAGEMENT]],
      ['findOne', [RoleName.ADMIN, RoleName.SELLER, RoleName.MANAGEMENT]],
      ['update', [RoleName.ADMIN, RoleName.SELLER]],
      ['activate', [RoleName.ADMIN]],
      ['deactivate', [RoleName.ADMIN]],
      ['block', [RoleName.ADMIN]],
      ['unblock', [RoleName.ADMIN]],
      ['convertToCustomer', [RoleName.ADMIN, RoleName.SELLER]],
    ])('%s expone @Roles(%p) exactamente', (methodName, roles) => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype[methodName],
      ) as RoleName[];
      expect(metadata).toEqual(roles);
    });

    it('WAREHOUSE no aparece en ningún endpoint de Customers', () => {
      const methodNames = [
        'create',
        'list',
        'findOne',
        'update',
        'activate',
        'deactivate',
        'block',
        'unblock',
        'convertToCustomer',
      ];
      for (const methodName of methodNames) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).not.toContain(RoleName.WAREHOUSE);
      }
    });

    it('MANAGEMENT solo aparece en list y findOne', () => {
      const withManagement = ['list', 'findOne'];
      const withoutManagement = [
        'create',
        'update',
        'activate',
        'deactivate',
        'block',
        'unblock',
        'convertToCustomer',
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

    it('SELLER aparece en create/list/findOne/update/convertToCustomer, no en activate/deactivate/block/unblock', () => {
      const withSeller = [
        'create',
        'list',
        'findOne',
        'update',
        'convertToCustomer',
      ];
      const withoutSeller = ['activate', 'deactivate', 'block', 'unblock'];
      for (const methodName of withSeller) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).toContain(RoleName.SELLER);
      }
      for (const methodName of withoutSeller) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).not.toContain(RoleName.SELLER);
      }
    });

    it('ADMIN aparece en los 9 endpoints', () => {
      const methodNames = [
        'create',
        'list',
        'findOne',
        'update',
        'activate',
        'deactivate',
        'block',
        'unblock',
        'convertToCustomer',
      ];
      for (const methodName of methodNames) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[methodName],
        ) as RoleName[];
        expect(metadata).toContain(RoleName.ADMIN);
      }
    });
  });

  describe('superficie exacta de rutas', () => {
    it('expone exactamente las 9 operaciones de Customers, sin DELETE/PUT ni rutas extra', () => {
      const methodNames = Object.getOwnPropertyNames(
        CustomersController.prototype,
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

      expect(routes).toHaveLength(9);
      expect(routes).toEqual(
        expect.arrayContaining([
          { method: RequestMethod.POST, path: '/' },
          { method: RequestMethod.GET, path: '/' },
          { method: RequestMethod.GET, path: ':id' },
          { method: RequestMethod.PATCH, path: ':id' },
          { method: RequestMethod.POST, path: ':id/activate' },
          { method: RequestMethod.POST, path: ':id/deactivate' },
          { method: RequestMethod.POST, path: ':id/block' },
          { method: RequestMethod.POST, path: ':id/unblock' },
          { method: RequestMethod.POST, path: ':id/convert-to-customer' },
        ]),
      );
      expect(
        routes.some((route) => route.method === RequestMethod.DELETE),
      ).toBe(false);
      expect(routes.some((route) => route.method === RequestMethod.PUT)).toBe(
        false,
      );
    });
  });
});
