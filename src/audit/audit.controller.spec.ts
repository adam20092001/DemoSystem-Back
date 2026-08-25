import { RoleName } from '@prisma/client';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AuditController } from './audit.controller';
import { AuditQueryService } from './audit-query.service';

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
    list: jest.fn<Promise<unknown>, [Record<string, unknown>, RoleName]>(),
    findOne: jest.fn<Promise<unknown>, [string, RoleName]>(),
  };
}

describe('AuditController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: AuditController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new AuditController(service as unknown as AuditQueryService);
  });

  it('list() delega en auditQueryService.list() con la query y el rol del actor', async () => {
    const query = { module: 'CONFIGURATION' };
    await controller.list(query as never, ACTOR);

    expect(service.list).toHaveBeenCalledWith(query, RoleName.ADMIN);
  });

  it('findOne() delega en auditQueryService.findOne() con el id y el rol del actor', async () => {
    await controller.findOne('audit-1', ACTOR);

    expect(service.findOne).toHaveBeenCalledWith('audit-1', RoleName.ADMIN);
  });

  it('list() propaga el rol MANAGEMENT tal cual', async () => {
    const management: AuthenticatedUser = {
      ...ACTOR,
      role: RoleName.MANAGEMENT,
    };
    await controller.list({}, management);

    expect(service.list).toHaveBeenCalledWith({}, RoleName.MANAGEMENT);
  });
});
