import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { SupplierPaymentsController } from './supplier-payments.controller';
import { SupplierPaymentsService } from './supplier-payments.service';

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

function createServiceMock() {
  return {
    list: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    findOne: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    create: jest.fn<Promise<unknown>, [unknown]>(),
    cancel: jest.fn<Promise<unknown>, [unknown]>(),
  };
}

describe('SupplierPaymentsController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: SupplierPaymentsController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new SupplierPaymentsController(
      service as unknown as SupplierPaymentsService,
    );
  });

  it('list delega query + rol actual', async () => {
    const expected = { data: [], page: 1, limit: 20, total: 0, totalPages: 0 };
    service.list.mockResolvedValue(expected);
    const result = await controller.list({}, ACTOR);
    expect(service.list).toHaveBeenCalledWith({}, RoleName.ADMIN);
    expect(result).toBe(expected);
  });

  it('findOne delega id + rol actual', async () => {
    const expected = { id: 'payment-1' };
    service.findOne.mockResolvedValue(expected);
    const result = await controller.findOne('payment-1', ACTOR);
    expect(service.findOne).toHaveBeenCalledWith('payment-1', RoleName.ADMIN);
    expect(result).toBe(expected);
  });

  it('create delega dto + actor, nunca acepta status/postedEntryId/currencyCode del body', async () => {
    const dto = {
      supplierId: 'supplier-1',
      amount: '150.00',
      method: 'CASH',
      allocations: [{ purchaseInvoiceId: 'invoice-1', amount: '150.00' }],
    };
    service.create.mockResolvedValue({ id: 'payment-1' });
    await controller.create(dto, ACTOR, REQUEST);
    expect(service.create).toHaveBeenCalledWith({
      supplierId: 'supplier-1',
      paymentDate: undefined,
      amount: '150.00',
      method: 'CASH',
      reference: undefined,
      idempotencyKey: undefined,
      allocations: dto.allocations,
      requesterRole: RoleName.ADMIN,
      actorUserId: 'actor-id',
      ipAddress: '10.0.0.1',
    });
  });

  it('cancel delega id + reason + actor', async () => {
    service.cancel.mockResolvedValue({ id: 'payment-1' });
    await controller.cancel('payment-1', { reason: 'motivo' }, ACTOR, REQUEST);
    expect(service.cancel).toHaveBeenCalledWith({
      supplierPaymentId: 'payment-1',
      reason: 'motivo',
      requesterRole: RoleName.ADMIN,
      actorUserId: 'actor-id',
      ipAddress: '10.0.0.1',
    });
  });

  it('expone @Roles(ADMIN, MANAGEMENT, ACCOUNTANT) en lectura y @Roles(ADMIN) exclusivamente en escritura', () => {
    const prototype = SupplierPaymentsController.prototype as unknown as Record<
      string,
      object
    >;
    const readRoles = [
      RoleName.ADMIN,
      RoleName.MANAGEMENT,
      RoleName.ACCOUNTANT,
    ];
    expect(Reflect.getMetadata(ROLES_KEY, prototype.list)).toEqual(readRoles);
    expect(Reflect.getMetadata(ROLES_KEY, prototype.findOne)).toEqual(
      readRoles,
    );
    expect(Reflect.getMetadata(ROLES_KEY, prototype.create)).toEqual([
      RoleName.ADMIN,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, prototype.cancel)).toEqual([
      RoleName.ADMIN,
    ]);
  });
});
