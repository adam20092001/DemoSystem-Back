import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PurchaseInvoicesController } from './purchase-invoices.controller';
import { PurchaseInvoicesService } from './purchase-invoices.service';

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

const REQUEST = { ip: '10.0.0.1' } as unknown as import('express').Request;

const controllerPrototype =
  PurchaseInvoicesController.prototype as unknown as Record<string, object>;

function createServiceMock() {
  return {
    listDrafts: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    findOne: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    create: jest.fn<Promise<unknown>, [unknown]>(),
    update: jest.fn<Promise<unknown>, [unknown]>(),
    confirm: jest.fn<Promise<unknown>, [unknown]>(),
    cancel: jest.fn<Promise<unknown>, [unknown]>(),
  };
}

describe('PurchaseInvoicesController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: PurchaseInvoicesController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new PurchaseInvoicesController(
      service as unknown as PurchaseInvoicesService,
    );
  });

  describe('delegación', () => {
    it('list delega query + rol actual', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      service.listDrafts.mockResolvedValue(expected);
      const result = await controller.list({ page: 2 }, ACTOR);
      expect(service.listDrafts).toHaveBeenCalledWith(
        { page: 2 },
        RoleName.ADMIN,
      );
      expect(result).toBe(expected);
    });

    it('findOne delega id + rol actual', async () => {
      const expected = { id: 'inv-1' };
      service.findOne.mockResolvedValue(expected);
      const result = await controller.findOne('inv-1', ACTOR);
      expect(service.findOne).toHaveBeenCalledWith('inv-1', RoleName.ADMIN);
      expect(result).toBe(expected);
    });

    it('create nunca acepta currencyCode/status del body: construye el input exclusivamente desde el DTO + actor', async () => {
      const dto = {
        supplierId: 'sup-1',
        documentType: 'FACTURA' as const,
        documentNumber: '123',
        issueDate: '2026-03-01',
        lines: [],
      };
      service.create.mockResolvedValue({ id: 'inv-1' });
      await controller.create(dto, ACTOR, REQUEST);
      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({
          supplierId: 'sup-1',
          documentType: 'FACTURA',
          documentNumber: '123',
          issueDate: '2026-03-01',
          lines: [],
          requesterRole: RoleName.ADMIN,
          actorUserId: 'actor-id',
          ipAddress: '10.0.0.1',
        }),
      );
      expect(
        'currencyCode' in
          (service.create.mock.calls[0][0] as Record<string, unknown>),
      ).toBe(false);
    });

    it('confirm delega id + actor, sin body', async () => {
      service.confirm.mockResolvedValue({ id: 'inv-1' });
      await controller.confirm('inv-1', ACTOR, REQUEST);
      expect(service.confirm).toHaveBeenCalledWith({
        purchaseInvoiceId: 'inv-1',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'actor-id',
        ipAddress: '10.0.0.1',
      });
    });

    it('cancel delega id + reason + actor', async () => {
      service.cancel.mockResolvedValue({ id: 'inv-1' });
      await controller.cancel('inv-1', { reason: 'motivo' }, ACTOR, REQUEST);
      expect(service.cancel).toHaveBeenCalledWith({
        purchaseInvoiceId: 'inv-1',
        reason: 'motivo',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'actor-id',
        ipAddress: '10.0.0.1',
      });
    });
  });

  describe('matriz exacta de roles', () => {
    const readRoutes = ['list', 'findOne'];
    const mutateRoutes = ['create', 'update', 'confirm', 'cancel'];

    it.each(readRoutes)(
      '%s expone @Roles(ADMIN, MANAGEMENT, ACCOUNTANT) exactamente',
      (name) => {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[name],
        ) as RoleName[];
        expect(metadata).toEqual([
          RoleName.ADMIN,
          RoleName.MANAGEMENT,
          RoleName.ACCOUNTANT,
        ]);
      },
    );

    it.each(mutateRoutes)(
      '%s expone @Roles(ADMIN) exclusivamente (A5.2a kickoff: MANAGEMENT/ACCOUNTANT nunca escriben aquí)',
      (name) => {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[name],
        ) as RoleName[];
        expect(metadata).toEqual([RoleName.ADMIN]);
      },
    );

    it('ninguna ruta incluye SELLER ni WAREHOUSE', () => {
      for (const name of [...readRoutes, ...mutateRoutes]) {
        const metadata = Reflect.getMetadata(
          ROLES_KEY,
          controllerPrototype[name],
        ) as RoleName[];
        expect(metadata).not.toContain(RoleName.SELLER);
        expect(metadata).not.toContain(RoleName.WAREHOUSE);
      }
    });
  });
});
