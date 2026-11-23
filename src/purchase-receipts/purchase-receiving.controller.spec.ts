import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PurchaseReceivingController } from './purchase-receiving.controller';
import { PurchaseReceivingService } from './purchase-receiving.service';

const WAREHOUSE_USER: AuthenticatedUser = {
  id: 'user-1',
  firstName: 'Walter',
  lastName: 'Warehouse',
  username: 'warehouse',
  email: 'warehouse@demosystem.local',
  role: RoleName.WAREHOUSE,
  status: 'ACTIVE',
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('PurchaseReceivingController (R1)', () => {
  const service = {
    listReceivableInvoices: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
    findReceivableInvoice: jest.fn<Promise<unknown>, [string, RoleName]>(),
  };
  const controller = new PurchaseReceivingController(
    service as unknown as PurchaseReceivingService,
  );
  const prototype = PurchaseReceivingController.prototype as unknown as Record<
    string,
    object
  >;

  it('listInvoices delega query + rol activo', async () => {
    service.listReceivableInvoices.mockResolvedValue({ data: [] });
    const query = { page: 2, limit: 10 };
    await controller.listInvoices(query, WAREHOUSE_USER);
    expect(service.listReceivableInvoices).toHaveBeenCalledWith(
      query,
      RoleName.WAREHOUSE,
    );
  });

  it('findInvoice delega id + rol activo', async () => {
    service.findReceivableInvoice.mockResolvedValue({ id: 'inv-1' });
    await controller.findInvoice('inv-1', WAREHOUSE_USER);
    expect(service.findReceivableInvoice).toHaveBeenCalledWith(
      'inv-1',
      RoleName.WAREHOUSE,
    );
  });

  it.each(['listInvoices', 'findInvoice'])(
    '%s expone @Roles(ADMIN, WAREHOUSE, MANAGEMENT, ACCOUNTANT, PURCHASING) exactamente: nunca SELLER (R3)',
    (method) => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        prototype[method],
      ) as RoleName[];
      expect(roles).toEqual([
        RoleName.ADMIN,
        RoleName.WAREHOUSE,
        RoleName.MANAGEMENT,
        RoleName.ACCOUNTANT,
        RoleName.PURCHASING,
      ]);
      expect(roles).not.toContain(RoleName.SELLER);
    },
  );

  it('superficie exacta: solo dos rutas GET, ninguna de escritura', () => {
    const methods = Object.getOwnPropertyNames(
      PurchaseReceivingController.prototype,
    ).filter((name) => name !== 'constructor');
    expect(methods.sort()).toEqual(['findInvoice', 'listInvoices']);
  });
});
