import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  PurchaseInvoiceReceiptsController,
  PurchaseReceiptsController,
} from './purchase-receipts.controller';
import { PurchaseReceiptsService } from './purchase-receipts.service';

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
    listByInvoice: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    findOne: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    create: jest.fn<Promise<unknown>, [unknown]>(),
    cancel: jest.fn<Promise<unknown>, [unknown]>(),
  };
}

describe('PurchaseInvoiceReceiptsController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: PurchaseInvoiceReceiptsController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new PurchaseInvoiceReceiptsController(
      service as unknown as PurchaseReceiptsService,
    );
  });

  it('listReceipts delega invoiceId + rol actual', async () => {
    const expected = { purchaseInvoiceId: 'inv-1', receipts: [], lines: [] };
    service.listByInvoice.mockResolvedValue(expected);
    const result = await controller.listReceipts('inv-1', ACTOR);
    expect(service.listByInvoice).toHaveBeenCalledWith('inv-1', RoleName.ADMIN);
    expect(result).toBe(expected);
  });

  it('create delega invoiceId + dto + actor, nunca acepta status/reclassificationEntryId del body', async () => {
    const dto = {
      receivedDate: '2026-03-20',
      lines: [{ purchaseInvoiceLineId: 'line-1', quantity: '4.000' }],
    };
    service.create.mockResolvedValue({ id: 'receipt-1' });
    await controller.create('inv-1', dto, ACTOR, REQUEST);
    expect(service.create).toHaveBeenCalledWith({
      purchaseInvoiceId: 'inv-1',
      receivedDate: '2026-03-20',
      notes: undefined,
      idempotencyKey: undefined,
      lines: dto.lines,
      requesterRole: RoleName.ADMIN,
      actorUserId: 'actor-id',
      ipAddress: '10.0.0.1',
    });
  });

  it('expone @Roles(ADMIN, MANAGEMENT, ACCOUNTANT) en listReceipts y @Roles(ADMIN) exclusivamente en create', () => {
    const prototype =
      PurchaseInvoiceReceiptsController.prototype as unknown as Record<
        string,
        object
      >;
    expect(Reflect.getMetadata(ROLES_KEY, prototype.listReceipts)).toEqual([
      RoleName.ADMIN,
      RoleName.MANAGEMENT,
      RoleName.ACCOUNTANT,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, prototype.create)).toEqual([
      RoleName.ADMIN,
    ]);
  });
});

describe('PurchaseReceiptsController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: PurchaseReceiptsController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new PurchaseReceiptsController(
      service as unknown as PurchaseReceiptsService,
    );
  });

  it('findOne delega id + rol actual', async () => {
    const expected = { id: 'receipt-1' };
    service.findOne.mockResolvedValue(expected);
    const result = await controller.findOne('receipt-1', ACTOR);
    expect(service.findOne).toHaveBeenCalledWith('receipt-1', RoleName.ADMIN);
    expect(result).toBe(expected);
  });

  it('cancel delega id + reason + actor', async () => {
    service.cancel.mockResolvedValue({ id: 'receipt-1' });
    await controller.cancel('receipt-1', { reason: 'motivo' }, ACTOR, REQUEST);
    expect(service.cancel).toHaveBeenCalledWith({
      purchaseReceiptId: 'receipt-1',
      reason: 'motivo',
      requesterRole: RoleName.ADMIN,
      actorUserId: 'actor-id',
      ipAddress: '10.0.0.1',
    });
  });

  it('expone @Roles(ADMIN, MANAGEMENT, ACCOUNTANT) en findOne y @Roles(ADMIN) exclusivamente en cancel; ninguno incluye SELLER/WAREHOUSE', () => {
    const prototype = PurchaseReceiptsController.prototype as unknown as Record<
      string,
      object
    >;
    const readMetadata = Reflect.getMetadata(
      ROLES_KEY,
      prototype.findOne,
    ) as RoleName[];
    const writeMetadata = Reflect.getMetadata(
      ROLES_KEY,
      prototype.cancel,
    ) as RoleName[];
    expect(readMetadata).toEqual([
      RoleName.ADMIN,
      RoleName.MANAGEMENT,
      RoleName.ACCOUNTANT,
    ]);
    expect(writeMetadata).toEqual([RoleName.ADMIN]);
    expect(readMetadata).not.toContain(RoleName.SELLER);
    expect(readMetadata).not.toContain(RoleName.WAREHOUSE);
    expect(writeMetadata).not.toContain(RoleName.SELLER);
    expect(writeMetadata).not.toContain(RoleName.WAREHOUSE);
  });
});
