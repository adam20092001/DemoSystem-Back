import { StreamableFile } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AccountsPayableController } from './accounts-payable.controller';
import { AccountsPayableService } from './accounts-payable.service';

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

function createServiceMock() {
  return {
    list: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    getDetail: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    getSummary: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    getAging: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    getReconciliation: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    exportDetailedXlsx: jest.fn<Promise<Buffer>, [unknown, unknown]>(),
    exportSummaryXlsx: jest.fn<Promise<Buffer>, [unknown, unknown]>(),
    exportAgingXlsx: jest.fn<Promise<Buffer>, [unknown, unknown]>(),
    exportReconciliationXlsx: jest.fn<Promise<Buffer>, [unknown, unknown]>(),
  };
}

describe('AccountsPayableController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: AccountsPayableController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new AccountsPayableController(
      service as unknown as AccountsPayableService,
    );
  });

  it('list delega query + rol actual', async () => {
    const expected = { data: [], page: 1, limit: 20, total: 0, totalPages: 0 };
    service.list.mockResolvedValue(expected);
    const result = await controller.list({}, ACTOR);
    expect(service.list).toHaveBeenCalledWith({}, RoleName.ADMIN);
    expect(result).toBe(expected);
  });

  it('getDetail delega purchaseInvoiceId + rol actual', async () => {
    const expected = { purchaseInvoiceId: 'invoice-1', payments: [] };
    service.getDetail.mockResolvedValue(expected);
    const result = await controller.getDetail('invoice-1', ACTOR);
    expect(service.getDetail).toHaveBeenCalledWith('invoice-1', RoleName.ADMIN);
    expect(result).toBe(expected);
  });

  it('getSummary delega query + rol actual', async () => {
    const expected = { bySupplier: [], grandTotal: {} };
    service.getSummary.mockResolvedValue(expected);
    const result = await controller.getSummary({}, ACTOR);
    expect(service.getSummary).toHaveBeenCalledWith({}, RoleName.ADMIN);
    expect(result).toBe(expected);
  });

  it('getAging delega query + rol actual', async () => {
    const expected = {
      asOfDate: '2026-06-15',
      totals: {},
      bySupplier: [],
      limitations: [],
    };
    service.getAging.mockResolvedValue(expected);
    const result = await controller.getAging({}, ACTOR);
    expect(service.getAging).toHaveBeenCalledWith({}, RoleName.ADMIN);
    expect(result).toBe(expected);
  });

  it('getReconciliation delega query + rol actual', async () => {
    const expected = {
      invoices: [],
      accounts: [],
      overallConsistent: true,
      limitations: [],
    };
    service.getReconciliation.mockResolvedValue(expected);
    const result = await controller.getReconciliation({}, ACTOR);
    expect(service.getReconciliation).toHaveBeenCalledWith({}, RoleName.ADMIN);
    expect(result).toBe(expected);
  });

  it('exportDetailedXlsx delega query + rol actual y envuelve el buffer en StreamableFile', async () => {
    service.exportDetailedXlsx.mockResolvedValue(Buffer.from('xlsx-bytes'));
    const result = await controller.exportDetailedXlsx({}, ACTOR);
    expect(service.exportDetailedXlsx).toHaveBeenCalledWith({}, RoleName.ADMIN);
    expect(result).toBeInstanceOf(StreamableFile);
  });

  it('exportSummaryXlsx delega query + rol actual y envuelve el buffer en StreamableFile', async () => {
    service.exportSummaryXlsx.mockResolvedValue(Buffer.from('xlsx-bytes'));
    const result = await controller.exportSummaryXlsx({}, ACTOR);
    expect(service.exportSummaryXlsx).toHaveBeenCalledWith({}, RoleName.ADMIN);
    expect(result).toBeInstanceOf(StreamableFile);
  });

  it('exportAgingXlsx delega query + rol actual y envuelve el buffer en StreamableFile', async () => {
    service.exportAgingXlsx.mockResolvedValue(Buffer.from('xlsx-bytes'));
    const result = await controller.exportAgingXlsx({}, ACTOR);
    expect(service.exportAgingXlsx).toHaveBeenCalledWith({}, RoleName.ADMIN);
    expect(result).toBeInstanceOf(StreamableFile);
  });

  it('exportReconciliationXlsx delega query + rol actual y envuelve el buffer en StreamableFile', async () => {
    service.exportReconciliationXlsx.mockResolvedValue(
      Buffer.from('xlsx-bytes'),
    );
    const result = await controller.exportReconciliationXlsx({}, ACTOR);
    expect(service.exportReconciliationXlsx).toHaveBeenCalledWith(
      {},
      RoleName.ADMIN,
    );
    expect(result).toBeInstanceOf(StreamableFile);
  });

  it('expone @Roles(ADMIN, MANAGEMENT, ACCOUNTANT) en TODOS los endpoints, nunca SELLER/WAREHOUSE', () => {
    const prototype = AccountsPayableController.prototype as unknown as Record<
      string,
      object
    >;
    const readRoles = [
      RoleName.ADMIN,
      RoleName.MANAGEMENT,
      RoleName.ACCOUNTANT,
    ];
    const methods = [
      'list',
      'getDetail',
      'getSummary',
      'getAging',
      'getReconciliation',
      'exportDetailedXlsx',
      'exportSummaryXlsx',
      'exportAgingXlsx',
      'exportReconciliationXlsx',
    ];
    for (const method of methods) {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        prototype[method],
      ) as RoleName[];
      expect(roles).toEqual(readRoles);
      expect(roles).not.toContain(RoleName.SELLER);
      expect(roles).not.toContain(RoleName.WAREHOUSE);
    }
  });
});
