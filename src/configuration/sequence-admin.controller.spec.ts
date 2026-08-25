import { DocumentType, RoleName } from '@prisma/client';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { SequenceAdminController } from './sequence-admin.controller';
import { SequenceAdminService } from './sequence-admin.service';

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
    listSequences: jest.fn<Promise<unknown>, [RoleName]>(),
    updateSequence: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
  };
}

describe('SequenceAdminController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: SequenceAdminController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new SequenceAdminController(
      service as unknown as SequenceAdminService,
    );
  });

  it('list() delega en sequenceAdminService.listSequences() con el rol del actor', async () => {
    await controller.list(ACTOR);

    expect(service.listSequences).toHaveBeenCalledWith(RoleName.ADMIN);
  });

  it('update() combina documentType (parámetro de ruta) + DTO + actor + ip', async () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;

    await controller.update(
      DocumentType.QUOTE,
      { prefix: 'Q-', padding: 8, currentNumber: 500 },
      ACTOR,
      request,
    );

    expect(service.updateSequence).toHaveBeenCalledWith({
      documentType: DocumentType.QUOTE,
      prefix: 'Q-',
      padding: 8,
      currentNumber: 500,
      actorUserId: 'actor-id',
      ipAddress: '203.0.113.5',
      requesterRole: RoleName.ADMIN,
    });
  });

  it('update() envía ipAddress null cuando la request no tiene ip', async () => {
    const request = {} as unknown as Request;

    await controller.update(
      DocumentType.SALE,
      { currentNumber: 10 },
      ACTOR,
      request,
    );

    expect(service.updateSequence).toHaveBeenCalledWith(
      expect.objectContaining({
        ipAddress: null,
        documentType: DocumentType.SALE,
      }),
    );
  });

  it('update() propaga campos ausentes del DTO como undefined (nunca inventa un valor)', async () => {
    const request = { ip: '10.0.0.1' } as unknown as Request;

    await controller.update(
      DocumentType.QUOTE,
      { prefix: 'Q-' },
      ACTOR,
      request,
    );

    expect(service.updateSequence).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: 'Q-',
        padding: undefined,
        currentNumber: undefined,
      }),
    );
  });
});
