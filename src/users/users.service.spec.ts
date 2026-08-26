import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { RoleName, UserStatus } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { UsersService } from './users.service';

interface RoleFindUniqueArgs {
  where: { name: RoleName };
}
interface UserCreateArgs {
  data: Record<string, unknown>;
}
interface UserUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}
interface UserFindUniqueArgs {
  where: { id: string };
}
interface UserRoleDeleteManyArgs {
  where: { userId: string };
}
interface UserRoleCreateManyArgs {
  data: { userId: string; roleId: string }[];
}

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');
const ADMIN_ROLE_ID = `role-${RoleName.ADMIN}`;

function makeRole(name: RoleName, id = `role-${name}`) {
  return { id, name };
}

/**
 * KAN-18, Bloque A: `roles` (arreglo de membresías UserRole, cada una con su
 * Role anidado) reemplaza a la relación singular `role`. Por defecto, un
 * único rol asignado — los escenarios multi-rol lo sobrescriben vía
 * `overrides.roles`.
 */
function makeUserRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    firstName: 'Juan',
    lastName: 'Pérez',
    username: 'jperez',
    email: 'jperez@demosystem.local',
    status: UserStatus.ACTIVE,
    mustChangePassword: true,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    roles: [{ role: { name: RoleName.SELLER } }],
    ...overrides,
  };
}

function rolesOf(...names: RoleName[]) {
  return names.map((name) => ({ role: { name } }));
}

/**
 * Resuelve `tx.role.findUnique` según el `name` solicitado, sobre un mapa de
 * roles conocidos — necesario porque `resolveRoleIds()` hace una llamada por
 * cada nombre en `roleNames` (vía `Promise.all`), y los escenarios
 * multi-rol necesitan que cada llamada devuelva el `Role` correcto, no
 * siempre el mismo.
 */
function mockKnownRoles(
  tx: ReturnType<typeof createPrismaMock>['tx'],
  ...names: RoleName[]
) {
  const byName = new Map(names.map((name) => [name, makeRole(name)]));
  tx.role.findUnique.mockImplementation(({ where }: RoleFindUniqueArgs) =>
    Promise.resolve(byName.get(where.name) ?? null),
  );
}

/**
 * $transaction mockeado invoca el callback con `tx`, igual que Prisma real.
 * Si el callback lanza, la promesa de $transaction rechaza — así se
 * verifica, sin base de datos, que un fallo revierte la operación lógica.
 */
function createPrismaMock() {
  const tx = {
    role: {
      findUnique: jest.fn<Promise<unknown>, [RoleFindUniqueArgs]>(),
    },
    user: {
      create: jest.fn<Promise<unknown>, [UserCreateArgs]>(),
      update: jest.fn<Promise<unknown>, [UserUpdateArgs]>(),
      findUnique: jest.fn<Promise<unknown>, [UserFindUniqueArgs]>(),
      count: jest.fn<Promise<number>, unknown[]>(),
    },
    userRole: {
      deleteMany: jest.fn<Promise<unknown>, [UserRoleDeleteManyArgs]>(),
      createMany: jest.fn<Promise<unknown>, [UserRoleCreateManyArgs]>(),
    },
    // KAN-18, remediación de seguridad: lockAdminRoleForUpdate() usa
    // exclusivamente $queryRaw (plantilla Prisma.sql, parametrizada) —
    // $queryRawUnsafe se incluye SOLO para que cualquier uso accidental de
    // la variante insegura falle de inmediato en la prueba
    // correspondiente, nunca porque el código de producción deba llamarlo.
    $queryRaw: jest.fn<Promise<unknown>, [unknown]>(),
    $queryRawUnsafe: jest.fn<Promise<unknown>, [unknown]>(),
  };

  return {
    tx,
    role: {
      findUnique: jest.fn<Promise<unknown>, [RoleFindUniqueArgs]>(),
    },
    user: {
      findUnique: jest.fn<Promise<unknown>, [UserFindUniqueArgs]>(),
      findMany: jest.fn<Promise<unknown[]>, unknown[]>(),
      count: jest.fn<Promise<number>, unknown[]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createPasswordServiceMock() {
  return {
    hash: jest.fn<Promise<string>, [string]>(),
    verify: jest.fn<Promise<boolean>, [string, string]>(),
  };
}

function createAuditServiceMock() {
  return {
    record: jest.fn<Promise<void>, [Record<string, unknown>]>(),
  };
}

describe('UsersService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let passwordService: ReturnType<typeof createPasswordServiceMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: UsersService;

  beforeEach(() => {
    prisma = createPrismaMock();
    // Lock del Role ADMIN exitoso por defecto: la mayoría de las pruebas no
    // ejercitan la invariante de concurrencia y no deben preocuparse por
    // mockearlo explícitamente. Los escenarios de la §"lockAdminRoleForUpdate"
    // lo sobrescriben cuando necesitan simular ausencia de la fila ADMIN.
    prisma.tx.$queryRaw.mockResolvedValue([{ id: ADMIN_ROLE_ID }]);
    passwordService = createPasswordServiceMock();
    passwordService.hash.mockResolvedValue('$argon2id$hashed');
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);

    service = new UsersService(
      prisma as unknown as PrismaService,
      passwordService,
      auditService as unknown as AuditService,
    );
  });

  describe('createUser', () => {
    const validInput = {
      firstName: 'Juan',
      lastName: 'Pérez',
      username: '  JPerez  ',
      email: '  JPerez@DemoSystem.local  ',
      temporaryPassword: 'Temporal1234',
      roleNames: [RoleName.SELLER],
      actorUserId: ACTOR_ID,
      ipAddress: '10.0.0.5',
    };

    beforeEach(() => {
      mockKnownRoles(prisma.tx, RoleName.SELLER);
      prisma.tx.user.create.mockResolvedValue(makeUserRow());
    });

    it('crea el usuario y devuelve la forma segura', async () => {
      const result = await service.createUser(validInput);

      expect(result).toEqual({
        id: 'user-1',
        firstName: 'Juan',
        lastName: 'Pérez',
        username: 'jperez',
        email: 'jperez@demosystem.local',
        roles: [RoleName.SELLER],
        status: UserStatus.ACTIVE,
        mustChangePassword: true,
        lastLoginAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(result).not.toHaveProperty('passwordHash');
      expect(result).not.toHaveProperty('failedLoginAttempts');
      expect(result).not.toHaveProperty('roleId');
    });

    it('normaliza username y email antes de guardarlos', async () => {
      await service.createUser(validInput);

      const createArgs = prisma.tx.user.create.mock.calls[0][0];
      expect(createArgs.data.username).toBe('jperez');
      expect(createArgs.data.email).toBe('jperez@demosystem.local');
    });

    it('resuelve el rol por roleNames y no acepta un roleId externo', async () => {
      await service.createUser(validInput);

      expect(prisma.tx.role.findUnique).toHaveBeenCalledWith({
        where: { name: RoleName.SELLER },
      });
      const createArgs = prisma.tx.user.create.mock.calls[0][0];
      expect(createArgs.data.roles).toEqual({
        create: [{ roleId: `role-${RoleName.SELLER}` }],
      });
    });

    it('crea el usuario con múltiples roles simultáneos', async () => {
      mockKnownRoles(prisma.tx, RoleName.SELLER, RoleName.WAREHOUSE);
      prisma.tx.user.create.mockResolvedValue(
        makeUserRow({ roles: rolesOf(RoleName.SELLER, RoleName.WAREHOUSE) }),
      );

      const result = await service.createUser({
        ...validInput,
        roleNames: [RoleName.SELLER, RoleName.WAREHOUSE],
      });

      const createArgs = prisma.tx.user.create.mock.calls[0][0];
      expect(createArgs.data.roles).toEqual({
        create: [
          { roleId: `role-${RoleName.SELLER}` },
          { roleId: `role-${RoleName.WAREHOUSE}` },
        ],
      });
      expect(result.roles).toEqual(
        expect.arrayContaining([RoleName.SELLER, RoleName.WAREHOUSE]),
      );
    });

    it('rechaza roleNames duplicados', async () => {
      await expect(
        service.createUser({
          ...validInput,
          roleNames: [RoleName.SELLER, RoleName.SELLER],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rechaza roleNames vacío', async () => {
      await expect(
        service.createUser({ ...validInput, roleNames: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('envía la contraseña en texto plano a PasswordService.hash', async () => {
      await service.createUser(validInput);

      expect(passwordService.hash).toHaveBeenCalledWith('Temporal1234');
      const createArgs = prisma.tx.user.create.mock.calls[0][0];
      expect(createArgs.data.passwordHash).toBe('$argon2id$hashed');
    });

    it('registra USER_CREATED dentro de la misma transacción, sin secretos', async () => {
      await service.createUser(validInput);

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.USER_CREATED,
          userId: ACTOR_ID,
          client: prisma.tx,
        }),
      );
      const [call] = auditService.record.mock.calls[0];
      const serialized = JSON.stringify(call.metadata);
      expect(serialized).not.toContain('Temporal1234');
      expect(serialized).not.toContain('argon2id');
      expect(call.metadata).toEqual(
        expect.objectContaining({ roleNames: [RoleName.SELLER] }),
      );
    });

    it('rechaza una contraseña que no cumple la política', async () => {
      await expect(
        service.createUser({ ...validInput, temporaryPassword: 'corta1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rechaza un roleName inexistente', async () => {
      prisma.tx.role.findUnique.mockResolvedValue(null);

      await expect(service.createUser(validInput)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('revierte la operación si la auditoría falla (transacción simulada)', async () => {
      auditService.record.mockRejectedValue(new Error('fallo de auditoría'));

      await expect(service.createUser(validInput)).rejects.toThrow(
        'fallo de auditoría',
      );
      // El create se intentó, pero como $transaction propaga el rechazo,
      // en una base real la transacción completa se habría revertido.
      expect(prisma.tx.user.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('listUsers', () => {
    it('devuelve una respuesta paginada con los defaults', async () => {
      prisma.user.findMany.mockResolvedValue([makeUserRow()]);
      prisma.user.count.mockResolvedValue(1);

      const result = await service.listUsers({});

      expect(result).toEqual({
        data: [expect.objectContaining({ id: 'user-1' })],
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });

    it('limita el tamaño de página a 100', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.listUsers({ limit: 500 });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it('filtra por roleName como membresía (some), no como rol único', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.listUsers({ roleName: RoleName.WAREHOUSE });

      const findManyArgs = prisma.user.findMany.mock.calls[0][0] as {
        where: { roles?: unknown };
      };
      expect(findManyArgs.where.roles).toEqual({
        some: { role: { name: RoleName.WAREHOUSE } },
      });
    });
  });

  describe('findUserById', () => {
    it('devuelve la forma segura cuando el usuario existe', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUserRow());

      const result = await service.findUserById('user-1');

      expect(result.id).toBe('user-1');
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findUserById('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('updateUser', () => {
    it('permite editar firstName, lastName, email y roleNames (reemplazo total)', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        username: 'jperez',
        status: UserStatus.ACTIVE,
        roles: rolesOf(RoleName.SELLER),
      });
      mockKnownRoles(prisma.tx, RoleName.MANAGEMENT);
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ roles: rolesOf(RoleName.MANAGEMENT) }),
      );

      const result = await service.updateUser({
        userId: 'user-1',
        firstName: 'Juan Carlos',
        email: '  Nuevo@DemoSystem.local ',
        roleNames: [RoleName.MANAGEMENT],
        actorUserId: ACTOR_ID,
      });

      expect(result.roles).toEqual([RoleName.MANAGEMENT]);
      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.email).toBe('nuevo@demosystem.local');
      expect(prisma.tx.userRole.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(prisma.tx.userRole.createMany).toHaveBeenCalledWith({
        data: [{ userId: 'user-1', roleId: `role-${RoleName.MANAGEMENT}` }],
      });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.USER_UPDATED }),
      );
    });

    it('conserva los roles asignados cuando roleNames no se envía', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        username: 'jperez',
        status: UserStatus.ACTIVE,
        roles: rolesOf(RoleName.SELLER),
      });
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ firstName: 'Solo Nombre' }),
      );

      await service.updateUser({
        userId: 'user-1',
        firstName: 'Solo Nombre',
        actorUserId: ACTOR_ID,
      });

      expect(prisma.tx.userRole.deleteMany).not.toHaveBeenCalled();
      expect(prisma.tx.userRole.createMany).not.toHaveBeenCalled();
    });

    it('permite asignar múltiples roles a la vez', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        username: 'jperez',
        status: UserStatus.ACTIVE,
        roles: rolesOf(RoleName.SELLER),
      });
      mockKnownRoles(prisma.tx, RoleName.SELLER, RoleName.WAREHOUSE);
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ roles: rolesOf(RoleName.SELLER, RoleName.WAREHOUSE) }),
      );

      const result = await service.updateUser({
        userId: 'user-1',
        roleNames: [RoleName.SELLER, RoleName.WAREHOUSE],
        actorUserId: ACTOR_ID,
      });

      expect(result.roles).toEqual(
        expect.arrayContaining([RoleName.SELLER, RoleName.WAREHOUSE]),
      );
      expect(prisma.tx.userRole.createMany).toHaveBeenCalledWith({
        data: [
          { userId: 'user-1', roleId: `role-${RoleName.SELLER}` },
          { userId: 'user-1', roleId: `role-${RoleName.WAREHOUSE}` },
        ],
      });
    });

    it('rechaza roleNames vacío en un update', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        username: 'jperez',
        status: UserStatus.ACTIVE,
        roles: rolesOf(RoleName.SELLER),
      });

      await expect(
        service.updateUser({
          userId: 'user-1',
          roleNames: [],
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.userRole.deleteMany).not.toHaveBeenCalled();
    });

    it('registra addedRoles y removedRoles exactos en la auditoría', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        username: 'jperez',
        status: UserStatus.ACTIVE,
        roles: rolesOf(RoleName.SELLER, RoleName.WAREHOUSE),
      });
      mockKnownRoles(prisma.tx, RoleName.SELLER, RoleName.MANAGEMENT);
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ roles: rolesOf(RoleName.SELLER, RoleName.MANAGEMENT) }),
      );

      await service.updateUser({
        userId: 'user-1',
        roleNames: [RoleName.SELLER, RoleName.MANAGEMENT],
        actorUserId: ACTOR_ID,
      });

      const [call] = auditService.record.mock.calls[0];
      expect(call.metadata).toEqual(
        expect.objectContaining({
          roleNames: [RoleName.SELLER, RoleName.MANAGEMENT],
          addedRoles: [RoleName.MANAGEMENT],
          removedRoles: [RoleName.WAREHOUSE],
        }),
      );
    });

    it('rechaza un update sin ningún campo con BadRequestException', async () => {
      await expect(
        service.updateUser({ userId: 'user-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no abre la transacción cuando el update está vacío', async () => {
      await expect(
        service.updateUser({ userId: 'user-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('no llama a AuditService cuando el update está vacío', async () => {
      await expect(
        service.updateUser({ userId: 'user-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('permite un update con un único campo definido', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        username: 'jperez',
        status: UserStatus.ACTIVE,
        roles: rolesOf(RoleName.SELLER),
      });
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ firstName: 'Solo Nombre' }),
      );

      const result = await service.updateUser({
        userId: 'user-1',
        firstName: 'Solo Nombre',
        actorUserId: ACTOR_ID,
      });

      expect(result.firstName).toBe('Solo Nombre');
      expect(prisma.tx.role.findUnique).not.toHaveBeenCalled();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.USER_UPDATED }),
      );
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      prisma.tx.user.findUnique.mockResolvedValue(null);

      await expect(
        service.updateUser({
          userId: 'missing',
          firstName: 'Cualquiera',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('protección del último ADMIN activo al cambiar roleNames', () => {
      it('rechaza con 409 cuando el único ADMIN activo deja de tener ADMIN', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          roles: rolesOf(RoleName.ADMIN),
        });
        mockKnownRoles(prisma.tx, RoleName.SELLER);
        prisma.tx.user.count.mockResolvedValue(1);

        await expect(
          service.updateUser({
            userId: 'admin-1',
            roleNames: [RoleName.SELLER],
            actorUserId: 'admin-1',
          }),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('no llama a update ni a userRole cuando se rechaza', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          roles: rolesOf(RoleName.ADMIN),
        });
        mockKnownRoles(prisma.tx, RoleName.SELLER);
        prisma.tx.user.count.mockResolvedValue(1);

        await expect(
          service.updateUser({
            userId: 'admin-1',
            roleNames: [RoleName.SELLER],
            actorUserId: 'admin-1',
          }),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(prisma.tx.user.update).not.toHaveBeenCalled();
        expect(prisma.tx.userRole.deleteMany).not.toHaveBeenCalled();
      });

      it('no llama a AuditService cuando se rechaza', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          roles: rolesOf(RoleName.ADMIN),
        });
        mockKnownRoles(prisma.tx, RoleName.SELLER);
        prisma.tx.user.count.mockResolvedValue(1);

        await expect(
          service.updateUser({
            userId: 'admin-1',
            roleNames: [RoleName.SELLER],
            actorUserId: 'admin-1',
          }),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(auditService.record).not.toHaveBeenCalled();
      });

      it('permite el cambio si existen dos ADMIN activos', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          roles: rolesOf(RoleName.ADMIN),
        });
        mockKnownRoles(prisma.tx, RoleName.SELLER);
        prisma.tx.user.count.mockResolvedValue(2);
        prisma.tx.user.update.mockResolvedValue(
          makeUserRow({ id: 'admin-1', roles: rolesOf(RoleName.SELLER) }),
        );

        const result = await service.updateUser({
          userId: 'admin-1',
          roleNames: [RoleName.SELLER],
          actorUserId: 'otro-admin-id',
        });

        expect(result.roles).toEqual([RoleName.SELLER]);
        expect(auditService.record).toHaveBeenCalledWith(
          expect.objectContaining({ action: AuditAction.USER_UPDATED }),
        );
      });

      it('un ADMIN + SELLER cuenta como admin activo: rechaza si es el único', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          roles: rolesOf(RoleName.ADMIN, RoleName.SELLER),
        });
        mockKnownRoles(prisma.tx, RoleName.SELLER);
        prisma.tx.user.count.mockResolvedValue(1);

        await expect(
          service.updateUser({
            userId: 'admin-1',
            roleNames: [RoleName.SELLER],
            actorUserId: 'admin-1',
          }),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('quitar un rol distinto de ADMIN mientras se conserva ADMIN no dispara la protección', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          roles: rolesOf(RoleName.ADMIN, RoleName.SELLER),
        });
        mockKnownRoles(prisma.tx, RoleName.ADMIN);
        prisma.tx.user.update.mockResolvedValue(
          makeUserRow({ id: 'admin-1', roles: rolesOf(RoleName.ADMIN) }),
        );

        const result = await service.updateUser({
          userId: 'admin-1',
          roleNames: [RoleName.ADMIN],
          actorUserId: 'admin-1',
        });

        expect(result.roles).toEqual([RoleName.ADMIN]);
        expect(prisma.tx.user.count).not.toHaveBeenCalled();
      });

      it('ADMIN + SELLER -> ADMIN + MANAGEMENT: permitido, no reduce la población de ADMIN activos', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          roles: rolesOf(RoleName.ADMIN, RoleName.SELLER),
        });
        mockKnownRoles(prisma.tx, RoleName.ADMIN, RoleName.MANAGEMENT);
        prisma.tx.user.update.mockResolvedValue(
          makeUserRow({
            id: 'admin-1',
            roles: rolesOf(RoleName.ADMIN, RoleName.MANAGEMENT),
          }),
        );

        const result = await service.updateUser({
          userId: 'admin-1',
          roleNames: [RoleName.ADMIN, RoleName.MANAGEMENT],
          actorUserId: 'admin-1',
        });

        expect(result.roles).toEqual(
          expect.arrayContaining([RoleName.ADMIN, RoleName.MANAGEMENT]),
        );
        // El resultado sigue incluyendo ADMIN: no es una operación
        // potencialmente ADMIN-removing, así que ni el lock ni el conteo
        // deben ejecutarse (KAN-18, remediación de seguridad, §11).
        expect(prisma.tx.$queryRaw).not.toHaveBeenCalled();
        expect(prisma.tx.user.count).not.toHaveBeenCalled();
      });

      it('permite cambiar el rol de un usuario que no es ADMIN', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'user-1',
          username: 'jperez',
          status: UserStatus.ACTIVE,
          roles: rolesOf(RoleName.SELLER),
        });
        mockKnownRoles(prisma.tx, RoleName.WAREHOUSE);
        prisma.tx.user.update.mockResolvedValue(
          makeUserRow({ roles: rolesOf(RoleName.WAREHOUSE) }),
        );

        const result = await service.updateUser({
          userId: 'user-1',
          roleNames: [RoleName.WAREHOUSE],
          actorUserId: ACTOR_ID,
        });

        expect(result.roles).toEqual([RoleName.WAREHOUSE]);
        expect(prisma.tx.user.count).not.toHaveBeenCalled();
      });

      it('permite cambiar el rol de un ADMIN INACTIVE', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-2',
          username: 'admin_inactivo',
          status: UserStatus.INACTIVE,
          roles: rolesOf(RoleName.ADMIN),
        });
        mockKnownRoles(prisma.tx, RoleName.SELLER);
        prisma.tx.user.update.mockResolvedValue(
          makeUserRow({ id: 'admin-2', roles: rolesOf(RoleName.SELLER) }),
        );

        const result = await service.updateUser({
          userId: 'admin-2',
          roleNames: [RoleName.SELLER],
          actorUserId: ACTOR_ID,
        });

        expect(result.roles).toEqual([RoleName.SELLER]);
        expect(prisma.tx.user.count).not.toHaveBeenCalled();
      });
    });

    describe('KAN-18, remediación de seguridad: lock del Role ADMIN', () => {
      /**
       * Rastrea el orden real de invocación entre los mocks relevantes de
       * `tx`, para probar la secuencia exigida: lock -> relectura del
       * objetivo -> conteo -> mutación. Cualquier inversión (por ejemplo,
       * contar/decidir antes de bloquear) debe hacer fallar la aserción de
       * orden, no solo la de "fue llamado".
       */
      function trackCallOrder(
        tx: ReturnType<typeof createPrismaMock>['tx'],
      ): string[] {
        const order: string[] = [];
        // Envuelve las implementaciones YA configuradas por el test (no las
        // reemplaza): cada wrapper registra el paso en `order` y delega en
        // el mock "real" para preservar su valor de retorno.
        const wrap = <A extends unknown[], R>(
          mockFn: jest.Mock<Promise<R>, A>,
          label: string,
        ) => {
          const original = mockFn.getMockImplementation();
          mockFn.mockImplementation((...args: A) => {
            order.push(label);
            return original?.(...args) ?? Promise.resolve(undefined as R);
          });
        };
        wrap(tx.$queryRaw, 'lock');
        wrap(tx.user.findUnique, 'findUnique');
        wrap(tx.user.count, 'count');
        wrap(tx.userRole.deleteMany, 'mutate');
        return order;
      }

      it('en un reemplazo potencialmente ADMIN-removing: adquiere el lock ANTES de leer al objetivo, cuenta después, y muta al final', async () => {
        // Mocks "reales" configurados PRIMERO; trackCallOrder() envuelve
        // esas implementaciones ya existentes para no perder su valor de
        // retorno (mockResolvedValue reemplaza cualquier mockImplementation
        // previo, así que el orden de configuración aquí importa).
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          roles: rolesOf(RoleName.ADMIN),
        });
        mockKnownRoles(prisma.tx, RoleName.SELLER);
        prisma.tx.user.count.mockResolvedValue(2);
        prisma.tx.user.update.mockResolvedValue(
          makeUserRow({ id: 'admin-1', roles: rolesOf(RoleName.SELLER) }),
        );
        const order = trackCallOrder(prisma.tx);

        await service.updateUser({
          userId: 'admin-1',
          roleNames: [RoleName.SELLER],
          actorUserId: 'otro-admin-id',
        });

        expect(order).toEqual(['lock', 'findUnique', 'count', 'mutate']);
      });

      it('la consulta de lock usa Prisma.sql parametrizado (values=[ADMIN]), nunca texto interpolado', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          roles: rolesOf(RoleName.ADMIN),
        });
        mockKnownRoles(prisma.tx, RoleName.SELLER);
        prisma.tx.user.count.mockResolvedValue(2);
        prisma.tx.user.update.mockResolvedValue(
          makeUserRow({ id: 'admin-1', roles: rolesOf(RoleName.SELLER) }),
        );

        await service.updateUser({
          userId: 'admin-1',
          roleNames: [RoleName.SELLER],
          actorUserId: 'otro-admin-id',
        });

        expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(1);
        const [sql] = prisma.tx.$queryRaw.mock.calls[0] as [
          { values: unknown[]; strings: string[] },
        ];
        // Objeto Prisma.Sql real (plantilla etiquetada): el valor viaja en
        // `values`, nunca concatenado dentro de `strings`.
        expect(sql.values).toEqual([RoleName.ADMIN]);
        expect(sql.strings.join('')).not.toContain('ADMIN');
        expect(sql.strings.join(' ')).toMatch(/FOR UPDATE/);
        expect(prisma.tx.$queryRawUnsafe).not.toHaveBeenCalled();
      });

      it('falla cerrado con InternalServerErrorException si la fila del Role ADMIN no existe', async () => {
        prisma.tx.$queryRaw.mockResolvedValue([]);

        await expect(
          service.updateUser({
            userId: 'admin-1',
            roleNames: [RoleName.SELLER],
            actorUserId: ACTOR_ID,
          }),
        ).rejects.toThrow(/invariante del sistema violada/);
        // Ni siquiera llega a leer al usuario objetivo: el fallo cerrado
        // ocurre en el primer paso, antes de cualquier otra consulta.
        expect(prisma.tx.user.findUnique).not.toHaveBeenCalled();
      });

      it('NO adquiere el lock en una edición inocua (firstName), sin roleNames', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'user-1',
          username: 'jperez',
          status: UserStatus.ACTIVE,
          roles: rolesOf(RoleName.SELLER),
        });
        prisma.tx.user.update.mockResolvedValue(
          makeUserRow({ firstName: 'Solo Nombre' }),
        );

        await service.updateUser({
          userId: 'user-1',
          firstName: 'Solo Nombre',
          actorUserId: ACTOR_ID,
        });

        expect(prisma.tx.$queryRaw).not.toHaveBeenCalled();
      });

      it('NO adquiere el lock cuando roleNames se reemplaza pero sigue incluyendo ADMIN', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          roles: rolesOf(RoleName.ADMIN),
        });
        mockKnownRoles(prisma.tx, RoleName.ADMIN, RoleName.WAREHOUSE);
        prisma.tx.user.update.mockResolvedValue(
          makeUserRow({
            id: 'admin-1',
            roles: rolesOf(RoleName.ADMIN, RoleName.WAREHOUSE),
          }),
        );

        await service.updateUser({
          userId: 'admin-1',
          roleNames: [RoleName.ADMIN, RoleName.WAREHOUSE],
          actorUserId: 'admin-1',
        });

        expect(prisma.tx.$queryRaw).not.toHaveBeenCalled();
      });
    });
  });

  describe('blockUser', () => {
    it('rechaza el autobloqueo', async () => {
      await expect(
        service.blockUser({ targetUserId: ACTOR_ID, actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('protege al único ADMIN activo', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'admin',
        status: UserStatus.ACTIVE,
        roles: rolesOf(RoleName.ADMIN),
      });
      prisma.tx.user.count.mockResolvedValue(1);

      await expect(
        service.blockUser({ targetUserId: 'target-id', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.user.update).not.toHaveBeenCalled();
    });

    it('un ADMIN + SELLER también cuenta como admin activo protegido', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'admin',
        status: UserStatus.ACTIVE,
        roles: rolesOf(RoleName.ADMIN, RoleName.SELLER),
      });
      prisma.tx.user.count.mockResolvedValue(1);

      await expect(
        service.blockUser({ targetUserId: 'target-id', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.user.update).not.toHaveBeenCalled();
    });

    it('permite bloquear a un ADMIN si hay más de uno activo', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'admin2',
        status: UserStatus.ACTIVE,
        roles: rolesOf(RoleName.ADMIN),
      });
      prisma.tx.user.count.mockResolvedValue(2);
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ id: 'target-id', status: UserStatus.BLOCKED }),
      );

      const result = await service.blockUser({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      expect(result.status).toBe(UserStatus.BLOCKED);
    });

    it('bloquea correctamente a un usuario no ADMIN', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.ACTIVE,
        roles: rolesOf(RoleName.SELLER),
      });
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ id: 'target-id', status: UserStatus.BLOCKED }),
      );

      const result = await service.blockUser({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      expect(result.status).toBe(UserStatus.BLOCKED);
      expect(prisma.tx.user.count).not.toHaveBeenCalled();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.USER_BLOCKED }),
      );
    });

    it('lanza ConflictException si ya estaba bloqueado', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.BLOCKED,
        roles: rolesOf(RoleName.SELLER),
      });

      await expect(
        service.blockUser({ targetUserId: 'target-id', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      prisma.tx.user.findUnique.mockResolvedValue(null);

      await expect(
        service.blockUser({ targetUserId: 'missing', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un ADMIN BLOCKED/INACTIVE no cuenta como admin activo: bloquear al único ADMIN ACTIVE restante se rechaza', async () => {
      // Escenario: existen 2 filas ADMIN en total, pero solo 1 está ACTIVE
      // (la otra ya está BLOCKED/INACTIVE). La query real de
      // countActiveAdmins() filtra status=ACTIVE, así que el conteo
      // relevante es 1, no 2 — se simula directamente ese resultado ya
      // filtrado, tal como lo devolvería PostgreSQL.
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'admin_activo',
        status: UserStatus.ACTIVE,
        roles: rolesOf(RoleName.ADMIN),
      });
      prisma.tx.user.count.mockResolvedValue(1);

      await expect(
        service.blockUser({ targetUserId: 'target-id', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.user.update).not.toHaveBeenCalled();
    });

    describe('KAN-18, remediación de seguridad: lock del Role ADMIN', () => {
      it('adquiere el lock incondicionalmente, ANTES de leer al objetivo, incluso para un usuario no-ADMIN', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'target-id',
          username: 'jperez',
          status: UserStatus.ACTIVE,
          roles: rolesOf(RoleName.SELLER),
        });
        prisma.tx.user.update.mockResolvedValue(
          makeUserRow({ id: 'target-id', status: UserStatus.BLOCKED }),
        );
        const order: string[] = [];
        const originalQueryRaw = prisma.tx.$queryRaw.getMockImplementation();
        prisma.tx.$queryRaw.mockImplementation((...args) => {
          order.push('lock');
          return originalQueryRaw?.(...args) ?? Promise.resolve([]);
        });
        const originalFindUnique =
          prisma.tx.user.findUnique.getMockImplementation();
        prisma.tx.user.findUnique.mockImplementation((...args) => {
          order.push('findUnique');
          return originalFindUnique?.(...args) ?? Promise.resolve(null);
        });

        await service.blockUser({
          targetUserId: 'target-id',
          actorUserId: ACTOR_ID,
        });

        expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['lock', 'findUnique']);
      });

      it('falla cerrado con InternalServerErrorException si la fila del Role ADMIN no existe', async () => {
        prisma.tx.$queryRaw.mockResolvedValue([]);

        await expect(
          service.blockUser({
            targetUserId: 'target-id',
            actorUserId: ACTOR_ID,
          }),
        ).rejects.toThrow(/invariante del sistema violada/);
        expect(prisma.tx.user.findUnique).not.toHaveBeenCalled();
      });
    });
  });

  describe('unblockUser', () => {
    it('desbloquea correctamente y reinicia los intentos fallidos', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.BLOCKED,
      });
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ id: 'target-id', status: UserStatus.ACTIVE }),
      );

      const result = await service.unblockUser({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      expect(result.status).toBe(UserStatus.ACTIVE);
      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe(UserStatus.ACTIVE);
      expect(updateArgs.data.blockedAt).toBeNull();
      expect(updateArgs.data.failedLoginAttempts).toBe(0);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.USER_UNBLOCKED }),
      );
    });

    it('lanza ConflictException si no estaba bloqueado', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.ACTIVE,
      });

      await expect(
        service.unblockUser({
          targetUserId: 'target-id',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('resetPassword', () => {
    it('genera una contraseña temporal que cumple la política y marca mustChangePassword', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.ACTIVE,
      });
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ id: 'target-id', mustChangePassword: true }),
      );

      const result = await service.resetPassword({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(16);
      expect(result.temporaryPassword).toMatch(/[a-zA-Z]/);
      expect(result.temporaryPassword).toMatch(/[0-9]/);
      expect(result.user.mustChangePassword).toBe(true);
      expect(passwordService.hash).toHaveBeenCalledWith(
        result.temporaryPassword,
      );
    });

    it('activa a un usuario BLOCKED tras el reset', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.BLOCKED,
      });
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ id: 'target-id', status: UserStatus.ACTIVE }),
      );

      await service.resetPassword({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe(UserStatus.ACTIVE);
      expect(updateArgs.data.blockedAt).toBeNull();
    });

    it('mantiene INACTIVE como INACTIVE tras el reset', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.INACTIVE,
      });
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ id: 'target-id', status: UserStatus.INACTIVE }),
      );

      await service.resetPassword({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe(UserStatus.INACTIVE);
    });

    it('no guarda la contraseña temporal ni el hash en la auditoría', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.ACTIVE,
      });
      prisma.tx.user.update.mockResolvedValue(makeUserRow({ id: 'target-id' }));

      const result = await service.resetPassword({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      const [call] = auditService.record.mock.calls[0];
      const serialized = JSON.stringify(call.metadata);
      expect(serialized).not.toContain(result.temporaryPassword);
      expect(serialized).not.toContain('argon2id');
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.PASSWORD_RESET }),
      );
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      prisma.tx.user.findUnique.mockResolvedValue(null);

      await expect(
        service.resetPassword({
          targetUserId: 'missing',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
