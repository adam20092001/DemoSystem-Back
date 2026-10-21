import { RoleName, SupplierDocumentType } from '@prisma/client';
import type { Request } from 'express';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

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
const controllerPrototype = SuppliersController.prototype as unknown as Record<
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
  };
}

describe('SuppliersController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: SuppliersController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new SuppliersController(
      service as unknown as SuppliersService,
    );
  });

  describe('create', () => {
    const dto = {
      documentType: SupplierDocumentType.RUC,
      documentNumber: '20123456789',
      legalName: 'Importaciones Acme S.A.C.',
    };

    it('delega en service.create con el DTO, actorUserId y request IP', async () => {
      const expected = { id: 'supplier-1' };
      service.create.mockResolvedValue(expected);
      const request = { ip: '203.0.113.5' } as unknown as Request;

      const result = await controller.create(dto, ACTOR, request);

      expect(service.create).toHaveBeenCalledWith({
        documentType: SupplierDocumentType.RUC,
        documentNumber: '20123456789',
        countryCode: undefined,
        legalName: 'Importaciones Acme S.A.C.',
        tradeName: undefined,
        contactName: undefined,
        phone: undefined,
        email: undefined,
        address: undefined,
        internalNotes: undefined,
        defaultCurrencyCode: undefined,
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });
  });

  describe('list', () => {
    it('delega en service.list con la query y el rol actual', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      service.list.mockResolvedValue(expected);
      const result = await controller.list({}, ACTOR);
      expect(service.list).toHaveBeenCalledWith({}, RoleName.ADMIN);
      expect(result).toBe(expected);
    });
  });

  describe('findOne', () => {
    it('delega id y rol actual', async () => {
      const expected = { id: 'supplier-1' };
      service.findOne.mockResolvedValue(expected);
      const result = await controller.findOne('supplier-1', ACTOR);
      expect(service.findOne).toHaveBeenCalledWith(
        'supplier-1',
        RoleName.ADMIN,
      );
      expect(result).toBe(expected);
    });
  });

  describe('update', () => {
    it('delega en service.update con el id, el DTO, actorUserId y request IP', async () => {
      const expected = { id: 'supplier-1' };
      service.update.mockResolvedValue(expected);
      const request = { ip: '203.0.113.5' } as unknown as Request;
      const dto = { legalName: 'Nuevo nombre' };

      const result = await controller.update('supplier-1', dto, ACTOR, request);

      expect(service.update).toHaveBeenCalledWith({
        supplierId: 'supplier-1',
        documentType: undefined,
        documentNumber: undefined,
        countryCode: undefined,
        legalName: 'Nuevo nombre',
        tradeName: undefined,
        contactName: undefined,
        phone: undefined,
        email: undefined,
        address: undefined,
        internalNotes: undefined,
        defaultCurrencyCode: undefined,
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });
  });

  describe('activate/deactivate', () => {
    it('activate delega id, actorUserId e ip', async () => {
      const expected = { id: 'supplier-1' };
      service.activate.mockResolvedValue(expected);
      const request = { ip: '203.0.113.5' } as unknown as Request;
      const result = await controller.activate('supplier-1', ACTOR, request);
      expect(service.activate).toHaveBeenCalledWith({
        supplierId: 'supplier-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });

    it('deactivate delega id, actorUserId e ip', async () => {
      const expected = { id: 'supplier-1' };
      service.deactivate.mockResolvedValue(expected);
      const request = { ip: '203.0.113.5' } as unknown as Request;
      const result = await controller.deactivate('supplier-1', ACTOR, request);
      expect(service.deactivate).toHaveBeenCalledWith({
        supplierId: 'supplier-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });
  });

  describe('matriz exacta de roles', () => {
    it('list/findOne exponen @Roles(ADMIN, MANAGEMENT, ACCOUNTANT) exactamente', () => {
      for (const method of ['list', 'findOne']) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[method],
        ) as RoleName[];
        expect(metadata).toEqual([
          RoleName.ADMIN,
          RoleName.MANAGEMENT,
          RoleName.ACCOUNTANT,
        ]);
      }
    });

    it('create/update/activate/deactivate exponen @Roles(ADMIN) exclusivamente', () => {
      for (const method of ['create', 'update', 'activate', 'deactivate']) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[method],
        ) as RoleName[];
        expect(metadata).toEqual([RoleName.ADMIN]);
      }
    });

    it('SELLER y WAREHOUSE no aparecen en ningún método', () => {
      for (const method of [
        'list',
        'findOne',
        'create',
        'update',
        'activate',
        'deactivate',
      ]) {
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
    it('expone exactamente 6 operaciones (list, findOne, create, update, activate, deactivate)', () => {
      const methodNames = Object.getOwnPropertyNames(
        SuppliersController.prototype,
      ).filter((name) => name !== 'constructor');
      expect(methodNames.sort()).toEqual(
        [
          'list',
          'findOne',
          'create',
          'update',
          'activate',
          'deactivate',
        ].sort(),
      );
    });
  });
});
