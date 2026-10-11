import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RoleName, UserStatus } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/** Evita que TS trate la referencia como un método enlazable (unbound-method). */
const controllerPrototype = UsersController.prototype as unknown as Record<
  string,
  object
>;

function createServiceMock() {
  return {
    lookupUsers: jest.fn<Promise<unknown[]>, []>(),
  };
}

describe('UsersController', () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: UsersController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new UsersController(service as unknown as UsersService);
  });

  describe('lookup (R3-B1)', () => {
    it('delega en UsersService.lookupUsers y retorna su resultado sin transformar', async () => {
      const rows = [
        {
          id: 'u-1',
          username: 'aactiva',
          firstName: 'Ana',
          lastName: 'Activa',
          status: UserStatus.ACTIVE,
        },
      ];
      service.lookupUsers.mockResolvedValue(rows);

      const result = await controller.lookup();

      expect(result).toBe(rows);
      expect(service.lookupUsers).toHaveBeenCalledTimes(1);
    });

    it('es GET /users/lookup', () => {
      const handler = controllerPrototype.lookup;
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        RequestMethod.GET,
      );
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('lookup');
    });

    it('declara a nivel de método ADMIN, SELLER y MANAGEMENT (sin WAREHOUSE)', () => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype.lookup,
      ) as RoleName[];
      expect(metadata).toEqual([
        RoleName.ADMIN,
        RoleName.SELLER,
        RoleName.MANAGEMENT,
      ]);
      expect(metadata).not.toContain(RoleName.WAREHOUSE);
    });

    it('se declara antes de GET :id, para que "lookup" nunca se resuelva como :id', () => {
      const methodNames = Object.getOwnPropertyNames(UsersController.prototype);
      expect(methodNames.indexOf('lookup')).toBeGreaterThanOrEqual(0);
      expect(methodNames.indexOf('lookup')).toBeLessThan(
        methodNames.indexOf('findOne'),
      );
    });
  });

  describe('autorización existente sin cambios', () => {
    it('la clase conserva @Roles(ADMIN)', () => {
      expect(Reflect.getMetadata(ROLES_KEY, UsersController)).toEqual([
        RoleName.ADMIN,
      ]);
    });

    it.each([
      'list',
      'findOne',
      'create',
      'update',
      'block',
      'unblock',
      'resetPassword',
    ])(
      '%s no declara @Roles propio (sigue rigiendo ADMIN de clase)',
      (methodName) => {
        const handler = controllerPrototype[methodName];
        expect(handler).toBeDefined();
        expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
      },
    );
  });
});
