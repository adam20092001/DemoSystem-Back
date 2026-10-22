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

  it('expone @Roles(ADMIN, MANAGEMENT, ACCOUNTANT), nunca SELLER/WAREHOUSE', () => {
    const prototype = AccountsPayableController.prototype as unknown as Record<
      string,
      object
    >;
    const readRoles = [
      RoleName.ADMIN,
      RoleName.MANAGEMENT,
      RoleName.ACCOUNTANT,
    ];
    const listRoles = Reflect.getMetadata(
      ROLES_KEY,
      prototype.list,
    ) as RoleName[];
    const detailRoles = Reflect.getMetadata(
      ROLES_KEY,
      prototype.getDetail,
    ) as RoleName[];
    expect(listRoles).toEqual(readRoles);
    expect(detailRoles).toEqual(readRoles);
    expect(listRoles).not.toContain(RoleName.SELLER);
    expect(listRoles).not.toContain(RoleName.WAREHOUSE);
  });
});
