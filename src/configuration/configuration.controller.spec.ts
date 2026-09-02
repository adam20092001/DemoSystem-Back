import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ConfigurationController } from './configuration.controller';
import { ConfigurationService } from './configuration.service';

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
    getConfiguration: jest.fn<Promise<unknown>, [RoleName]>(),
    getPosConfiguration: jest.fn<Promise<unknown>, [RoleName]>(),
    updateConfiguration: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
  };
}

describe('ConfigurationController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: ConfigurationController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new ConfigurationController(
      service as unknown as ConfigurationService,
    );
  });

  it('get() delega en configurationService.getConfiguration() con el rol del actor', async () => {
    await controller.get(ACTOR);

    expect(service.getConfiguration).toHaveBeenCalledWith(RoleName.ADMIN);
  });

  it('getPos() delega en configurationService.getPosConfiguration() con el rol del actor', async () => {
    await controller.getPos(ACTOR);

    expect(service.getPosConfiguration).toHaveBeenCalledWith(RoleName.ADMIN);
  });

  it('getPos() propaga el rol activo de un actor SELLER', async () => {
    const sellerActor: AuthenticatedUser = { ...ACTOR, role: RoleName.SELLER };

    await controller.getPos(sellerActor);

    expect(service.getPosConfiguration).toHaveBeenCalledWith(RoleName.SELLER);
  });

  it('update() toma actorUserId de @CurrentUser() e ipAddress de la request', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.update({ businessName: 'X' }, ACTOR, request);

    expect(service.updateConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        businessName: 'X',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
        requesterRole: RoleName.ADMIN,
      }),
    );
  });

  it('update() envía ipAddress null cuando la request no tiene ip', async () => {
    const request = {} as unknown as Request;

    await controller.update({ businessName: 'X' }, ACTOR, request);

    expect(service.updateConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: null }),
    );
  });

  it('update() propaga los 8 campos del Bloque A tal cual llegan en el DTO', async () => {
    const request = { ip: '10.0.0.1' } as unknown as Request;

    await controller.update(
      {
        businessName: 'Empresa',
        tradeName: null,
        taxId: '20123456789',
        address: 'Av. Siempre Viva 123',
        phone: '999888777',
        email: 'contacto@empresa.test',
        currencyCode: 'USD',
        currencySymbol: '$',
      },
      ACTOR,
      request,
    );

    expect(service.updateConfiguration).toHaveBeenCalledWith({
      businessName: 'Empresa',
      tradeName: null,
      taxId: '20123456789',
      address: 'Av. Siempre Viva 123',
      phone: '999888777',
      email: 'contacto@empresa.test',
      currencyCode: 'USD',
      currencySymbol: '$',
      actorUserId: 'actor-id',
      ipAddress: '10.0.0.1',
      requesterRole: RoleName.ADMIN,
    });
  });
});
