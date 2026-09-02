import { PaymentMethodAccountingDestination, RoleName } from '@prisma/client';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaymentMethodsController } from './payment-methods.controller';
import { PaymentMethodsService } from './payment-methods.service';

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
    listPaymentMethods: jest.fn<
      Promise<unknown[]>,
      [Record<string, unknown>, RoleName]
    >(),
    createPaymentMethod: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    updatePaymentMethod: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
  };
}

describe('PaymentMethodsController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: PaymentMethodsController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new PaymentMethodsController(
      service as unknown as PaymentMethodsService,
    );
  });

  it('list() delega en listPaymentMethods() con includeInactive y el rol del actor', async () => {
    await controller.list({ includeInactive: true }, ACTOR);

    expect(service.listPaymentMethods).toHaveBeenCalledWith(
      { includeInactive: true },
      RoleName.ADMIN,
    );
  });

  it('list() propaga includeInactive undefined tal cual', async () => {
    await controller.list({}, ACTOR);

    expect(service.listPaymentMethods).toHaveBeenCalledWith(
      { includeInactive: undefined },
      RoleName.ADMIN,
    );
  });

  it('create() toma actorUserId de @CurrentUser() e ipAddress de la request', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.create(
      {
        code: 'YAPE',
        name: 'Yape',
        requiresReference: true,
        affectsCashDrawer: false,
        accountingDestination: PaymentMethodAccountingDestination.BANK,
      },
      ACTOR,
      request,
    );

    expect(service.createPaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'YAPE',
        name: 'Yape',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      }),
    );
  });

  it('create() envía ipAddress null cuando la request no tiene ip', async () => {
    const request = {} as unknown as Request;

    await controller.create(
      {
        code: 'YAPE',
        name: 'Yape',
        requiresReference: true,
        affectsCashDrawer: false,
        accountingDestination: PaymentMethodAccountingDestination.BANK,
      },
      ACTOR,
      request,
    );

    expect(service.createPaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: null }),
    );
  });

  it('update() propaga paymentMethodId (del param :id) y el body tal cual, sin permitir code', async () => {
    const request = { ip: '10.0.0.1' } as unknown as Request;

    await controller.update(
      'pm-1',
      { name: 'Efectivo (caja)', active: false },
      ACTOR,
      request,
    );

    expect(service.updatePaymentMethod).toHaveBeenCalledWith({
      paymentMethodId: 'pm-1',
      name: 'Efectivo (caja)',
      active: false,
      requiresReference: undefined,
      affectsCashDrawer: undefined,
      accountingDestination: undefined,
      sortOrder: undefined,
      requesterRole: RoleName.ADMIN,
      actorUserId: 'actor-id',
      ipAddress: '10.0.0.1',
    });
  });
});
