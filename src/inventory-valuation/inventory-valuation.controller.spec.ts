import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { InventoryValuationController } from './inventory-valuation.controller';
import { InventoryValuationService } from './inventory-valuation.service';

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
    getValuedInventory: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    getPendingValuation: jest.fn<Promise<unknown>, [unknown, unknown]>(),
  };
}

describe('InventoryValuationController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: InventoryValuationController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new InventoryValuationController(
      service as unknown as InventoryValuationService,
    );
  });

  it('getValuedInventory delega query + rol actual', async () => {
    const expected = { data: [], page: 1, limit: 20, total: 0, totalPages: 0 };
    service.getValuedInventory.mockResolvedValue(expected);
    const result = await controller.getValuedInventory({}, ACTOR);
    expect(service.getValuedInventory).toHaveBeenCalledWith({}, RoleName.ADMIN);
    expect(result).toBe(expected);
  });

  it('getPendingValuation delega query + rol actual', async () => {
    const expected = { data: [], page: 1, limit: 20, total: 0, totalPages: 0 };
    service.getPendingValuation.mockResolvedValue(expected);
    const result = await controller.getPendingValuation({}, ACTOR);
    expect(service.getPendingValuation).toHaveBeenCalledWith(
      {},
      RoleName.ADMIN,
    );
    expect(result).toBe(expected);
  });

  it('expone @Roles(ADMIN, MANAGEMENT, ACCOUNTANT) en ambos endpoints, nunca SELLER/WAREHOUSE', () => {
    const prototype =
      InventoryValuationController.prototype as unknown as Record<
        string,
        object
      >;
    const readRoles = [
      RoleName.ADMIN,
      RoleName.MANAGEMENT,
      RoleName.ACCOUNTANT,
    ];
    const valuedRoles = Reflect.getMetadata(
      ROLES_KEY,
      prototype.getValuedInventory,
    ) as RoleName[];
    const pendingRoles = Reflect.getMetadata(
      ROLES_KEY,
      prototype.getPendingValuation,
    ) as RoleName[];
    expect(valuedRoles).toEqual(readRoles);
    expect(pendingRoles).toEqual(readRoles);
    expect(valuedRoles).not.toContain(RoleName.SELLER);
    expect(valuedRoles).not.toContain(RoleName.WAREHOUSE);
  });
});
