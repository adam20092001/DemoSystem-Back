import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { UnitsController } from './units.controller';
import { UnitsService } from './units.service';

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
    createUnit: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    updateUnit: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    activateUnit: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    deactivateUnit: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    listUnits: jest.fn<Promise<unknown>, [unknown, RoleName]>(),
    findUnitById: jest.fn<Promise<unknown>, [string, RoleName]>(),
  };
}

describe('UnitsController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: UnitsController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new UnitsController(service as unknown as UnitsService);
  });

  it('create() toma actorUserId de @CurrentUser() e ipAddress de la request', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.create(
      { code: 'KG', name: 'Kilogramo', abbreviation: 'KG' },
      ACTOR,
      request,
    );

    expect(service.createUnit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      }),
    );
  });

  it('update() propaga actorUserId e ipAddress', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.update('unit-1', { name: 'Y' }, ACTOR, request);

    expect(service.updateUnit).toHaveBeenCalledWith(
      expect.objectContaining({
        unitId: 'unit-1',
        actorUserId: 'actor-id',
        ipAddress: '203.0.113.5',
      }),
    );
  });

  it('activate() con ipAddress ausente en la request se envía como null', async () => {
    const request = {} as unknown as Request;

    await controller.activate('unit-1', ACTOR, request);

    expect(service.activateUnit).toHaveBeenCalledWith({
      unitId: 'unit-1',
      actorUserId: 'actor-id',
      ipAddress: null,
    });
  });

  it('deactivate() propaga actorUserId e ipAddress', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.deactivate('unit-1', ACTOR, request);

    expect(service.deactivateUnit).toHaveBeenCalledWith({
      unitId: 'unit-1',
      actorUserId: 'actor-id',
      ipAddress: '203.0.113.5',
    });
  });

  it('list() pasa el rol del solicitante al servicio', async () => {
    await controller.list({}, ACTOR);

    expect(service.listUnits).toHaveBeenCalledWith({}, RoleName.ADMIN);
  });

  it('findOne() pasa el rol del solicitante al servicio', async () => {
    await controller.findOne('unit-1', ACTOR);

    expect(service.findUnitById).toHaveBeenCalledWith('unit-1', RoleName.ADMIN);
  });
});
