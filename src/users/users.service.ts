import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RoleName, UserStatus } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { checkPasswordPolicy } from '../common/security/password-policy';
import { PasswordService } from '../common/security/password.service';
import { PrismaService } from '../database/prisma.service';
import {
  assignedRoleNames,
  toSafeUser,
  USER_WITH_ROLES_SELECT,
} from './mappers/user.mapper';
import {
  BlockUserInput,
  ResetPasswordInput,
  UnblockUserInput,
} from './types/block-user.input';
import { CreateUserInput } from './types/create-user.input';
import { ListUsersQuery, PaginatedResult } from './types/list-users.query';
import { ResetPasswordResult } from './types/reset-password.result';
import { SafeUser } from './types/safe-user';
import { UpdateUserInput } from './types/update-user.input';

const TEMPORARY_PASSWORD_LENGTH = 20;
// Sin 0/O ni 1/l/I, para reducir errores al transcribir la contraseña temporal.
const TEMPORARY_PASSWORD_CHARSET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly auditService: AuditService,
  ) {}

  async createUser(input: CreateUserInput): Promise<SafeUser> {
    this.assertPasswordPolicy(input.temporaryPassword);
    // Defensa en profundidad (mismo criterio que el resto del dominio: el
    // DTO ya valida forma/duplicados/mínimo, el servicio nunca confía
    // únicamente en eso — KAN-18, Bloque A).
    this.assertValidRoleNamesShape(input.roleNames);

    const username = normalize(input.username);
    const email = normalize(input.email);
    const passwordHash = await this.passwordService.hash(
      input.temporaryPassword,
    );

    return this.prisma.$transaction(async (tx) => {
      const roleIds = await this.resolveRoleIds(tx, input.roleNames);

      const created = await tx.user.create({
        data: {
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          username,
          email,
          passwordHash,
          status: UserStatus.ACTIVE,
          mustChangePassword: true,
          failedLoginAttempts: 0,
          // Reemplazo atómico: los UserRole se crean en la MISMA
          // transacción que el User — nunca existe una fila de usuario sin
          // ningún rol asignado, ni siquiera transitoriamente.
          roles: { create: roleIds.map((roleId) => ({ roleId })) },
        },
        select: USER_WITH_ROLES_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'USERS',
        action: AuditAction.USER_CREATED,
        entityType: 'User',
        entityId: created.id,
        description: `Usuario ${username} creado con rol(es) ${input.roleNames.join(', ')}`,
        metadata: { username, email, roleNames: input.roleNames },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeUser(created);
    });
  }

  async listUsers(query: ListUsersQuery): Promise<PaginatedResult<SafeUser>> {
    const page =
      query.page !== undefined && query.page > 0
        ? Math.floor(query.page)
        : DEFAULT_PAGE;
    const limit = Math.min(
      query.limit !== undefined && query.limit > 0
        ? Math.floor(query.limit)
        : DEFAULT_LIMIT,
      MAX_LIMIT,
    );
    const skip = (page - 1) * limit;

    const where: Prisma.UserWhereInput = {};
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.roleName !== undefined) {
      // KAN-18, Bloque A: "tiene ese rol asignado" (uno entre varios
      // posibles), nunca "es exactamente ese rol" — vía membresía en
      // UserRole, mismo parámetro público roleName de siempre.
      where.roles = { some: { role: { name: query.roleName } } };
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      where.OR = [
        { username: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: USER_WITH_ROLES_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: rows.map(toSafeUser),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findUserById(id: string): Promise<SafeUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: USER_WITH_ROLES_SELECT,
    });
    if (user === null) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return toSafeUser(user);
  }

  async updateUser(input: UpdateUserInput): Promise<SafeUser> {
    const hasAnyField =
      input.firstName !== undefined ||
      input.lastName !== undefined ||
      input.email !== undefined ||
      input.roleNames !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar: firstName, lastName, email o roleNames',
      );
    }
    if (input.roleNames !== undefined) {
      this.assertValidRoleNamesShape(input.roleNames);
    }

    // KAN-18, remediación de seguridad: esta decisión depende ÚNICAMENTE del
    // INPUT (¿se reemplazan los roles y el resultado ya no incluye ADMIN?),
    // nunca de una lectura previa de PostgreSQL. Es intencional: decidir
    // "¿hace falta el lock?" a partir de una fila de User ya leída abriría
    // la misma ventana de carrera que se está cerrando (leer -> decidir ->
    // bloquear -> seguir usando la lectura vieja). Con el input alcanza,
    // porque updateUser() nunca toca `status` — la única forma en que esta
    // operación puede reducir la población de ADMIN activos es quitando el
    // rol ADMIN de un objetivo que ya lo tenía.
    const isPotentiallyAdminRemoving =
      input.roleNames !== undefined &&
      !input.roleNames.includes(RoleName.ADMIN);

    return this.prisma.$transaction(async (tx) => {
      // El lock se adquiere ANTES de leer al usuario objetivo: ninguna
      // decisión de la invariante puede basarse en una foto tomada antes
      // del punto de serialización (ver lockAdminRoleForUpdate()).
      if (isPotentiallyAdminRemoving) {
        await this.lockAdminRoleForUpdate(tx);
      }

      const existing = await tx.user.findUnique({
        where: { id: input.userId },
        select: USER_WITH_ROLES_SELECT,
      });
      if (existing === null) {
        throw new NotFoundException('Usuario no encontrado');
      }

      const data: Prisma.UserUpdateInput = {};
      const updatedFields: string[] = [];

      if (input.firstName !== undefined) {
        data.firstName = input.firstName.trim();
        updatedFields.push('firstName');
      }
      if (input.lastName !== undefined) {
        data.lastName = input.lastName.trim();
        updatedFields.push('lastName');
      }
      if (input.email !== undefined) {
        data.email = normalize(input.email);
        updatedFields.push('email');
      }

      let addedRoles: RoleName[] | undefined;
      let removedRoles: RoleName[] | undefined;
      if (input.roleNames !== undefined) {
        const existingRoleNames = assignedRoleNames(existing);
        const roleIds = await this.resolveRoleIds(tx, input.roleNames);

        // El rol y el estado se leen de PostgreSQL DESPUÉS del lock (nunca
        // antes): el sistema siempre debe conservar al menos un ADMIN
        // ACTIVO (KAN-18, Bloque A, §14 del kickoff aprobado —
        // generalización de la invariante de Fase 1: un usuario cuenta
        // como admin activo si status=ACTIVE Y ADMIN está entre sus roles
        // asignados, incluso junto con otros roles). El COUNT de más abajo
        // solo puede ejecutarse de forma segura porque
        // isPotentiallyAdminRemoving ya tomó el lock del Role ADMIN antes
        // de leer este `existing`.
        if (isPotentiallyAdminRemoving) {
          const losesLastActiveAdmin =
            existingRoleNames.includes(RoleName.ADMIN) &&
            existing.status === UserStatus.ACTIVE;

          if (losesLastActiveAdmin) {
            const activeAdmins = await this.countActiveAdmins(tx);
            if (activeAdmins <= 1) {
              throw new ConflictException(
                'No es posible cambiar el rol del único administrador activo',
              );
            }
          }
        }

        // Reemplazo total, atómico dentro de la misma transacción que el
        // resto del update: nunca queda, ni siquiera transitoriamente, un
        // usuario con cero roles (deleteMany + createMany antes del
        // tx.user.update de abajo, todo o nada).
        await tx.userRole.deleteMany({ where: { userId: input.userId } });
        await tx.userRole.createMany({
          data: roleIds.map((roleId) => ({ userId: input.userId, roleId })),
        });

        updatedFields.push('roleNames');
        addedRoles = input.roleNames.filter(
          (name) => !existingRoleNames.includes(name),
        );
        removedRoles = existingRoleNames.filter(
          (name) => !input.roleNames?.includes(name),
        );
      }

      const updated = await tx.user.update({
        where: { id: input.userId },
        data,
        select: USER_WITH_ROLES_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'USERS',
        action: AuditAction.USER_UPDATED,
        entityType: 'User',
        entityId: input.userId,
        description: `Usuario ${existing.username} actualizado`,
        metadata: {
          updatedFields,
          ...(input.roleNames !== undefined
            ? {
                roleNames: input.roleNames,
                addedRoles: addedRoles ?? [],
                removedRoles: removedRoles ?? [],
              }
            : {}),
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeUser(updated);
    });
  }

  async blockUser(input: BlockUserInput): Promise<SafeUser> {
    if (input.targetUserId === input.actorUserId) {
      throw new BadRequestException(
        'Un administrador no puede bloquearse a sí mismo',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // KAN-18, remediación de seguridad: blockUser() siempre puede sacar a
      // un usuario de la población de ADMIN activos (a diferencia de
      // updateUser(), aquí no hay forma de predecir desde el INPUT si el
      // objetivo es admin — requiere leer la base), así que el lock se
      // adquiere incondicionalmente, ANTES de leer al objetivo. Esta es la
      // estrategia "más simple y segura" aprobada (KAN-18, remediación de
      // seguridad, §7): nunca se decide a partir de una foto de `target`
      // tomada antes del lock.
      await this.lockAdminRoleForUpdate(tx);

      const target = await tx.user.findUnique({
        where: { id: input.targetUserId },
        select: USER_WITH_ROLES_SELECT,
      });
      if (target === null) {
        throw new NotFoundException('Usuario no encontrado');
      }
      if (target.status === UserStatus.BLOCKED) {
        throw new ConflictException('El usuario ya está bloqueado');
      }

      // KAN-18, Bloque A: "es admin" ahora significa "ADMIN está entre sus
      // roles asignados", nunca "su único rol es ADMIN" — un usuario
      // ADMIN + SELLER sigue contando como admin activo. Leído DESPUÉS del
      // lock de arriba, nunca antes.
      if (assignedRoleNames(target).includes(RoleName.ADMIN)) {
        const activeAdmins = await this.countActiveAdmins(tx);
        if (activeAdmins <= 1) {
          throw new ConflictException(
            'No es posible bloquear al único administrador activo',
          );
        }
      }

      const blocked = await tx.user.update({
        where: { id: input.targetUserId },
        data: { status: UserStatus.BLOCKED, blockedAt: new Date() },
        select: USER_WITH_ROLES_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'USERS',
        action: AuditAction.USER_BLOCKED,
        entityType: 'User',
        entityId: input.targetUserId,
        description: `Usuario ${target.username} bloqueado`,
        metadata: { username: target.username },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeUser(blocked);
    });
  }

  async unblockUser(input: UnblockUserInput): Promise<SafeUser> {
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({
        where: { id: input.targetUserId },
        select: { id: true, username: true, status: true },
      });
      if (target === null) {
        throw new NotFoundException('Usuario no encontrado');
      }
      if (target.status !== UserStatus.BLOCKED) {
        throw new ConflictException('El usuario no está bloqueado');
      }

      const unblocked = await tx.user.update({
        where: { id: input.targetUserId },
        data: {
          status: UserStatus.ACTIVE,
          blockedAt: null,
          failedLoginAttempts: 0,
        },
        select: USER_WITH_ROLES_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'USERS',
        action: AuditAction.USER_UNBLOCKED,
        entityType: 'User',
        entityId: input.targetUserId,
        description: `Usuario ${target.username} desbloqueado`,
        metadata: { username: target.username },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeUser(unblocked);
    });
  }

  async resetPassword(input: ResetPasswordInput): Promise<ResetPasswordResult> {
    const temporaryPassword = this.generateTemporaryPassword();
    const passwordHash = await this.passwordService.hash(temporaryPassword);

    const user = await this.prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({
        where: { id: input.targetUserId },
        select: { id: true, username: true, status: true },
      });
      if (target === null) {
        throw new NotFoundException('Usuario no encontrado');
      }

      // BLOCKED pasa a ACTIVE; ACTIVE e INACTIVE conservan su estado actual.
      const nextStatus =
        target.status === UserStatus.BLOCKED
          ? UserStatus.ACTIVE
          : target.status;

      const updated = await tx.user.update({
        where: { id: input.targetUserId },
        data: {
          passwordHash,
          mustChangePassword: true,
          failedLoginAttempts: 0,
          status: nextStatus,
          blockedAt: null,
        },
        select: USER_WITH_ROLES_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'USERS',
        action: AuditAction.PASSWORD_RESET,
        entityType: 'User',
        entityId: input.targetUserId,
        description: `Contraseña reiniciada para ${target.username}`,
        metadata: { username: target.username },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return updated;
    });

    return { user: toSafeUser(user), temporaryPassword };
  }

  /** array no vacío, sin duplicados — defensa de servicio, nunca confía solo en el DTO. */
  private assertValidRoleNamesShape(roleNames: RoleName[]): void {
    if (roleNames.length === 0) {
      throw new BadRequestException('roleNames debe incluir al menos un rol');
    }
    if (new Set(roleNames).size !== roleNames.length) {
      throw new BadRequestException(
        'roleNames no puede contener roles duplicados',
      );
    }
  }

  /**
   * KAN-18, remediación de seguridad: punto único de serialización para
   * toda operación capaz de reducir la población de ADMIN activos
   * (updateUser() quitando el rol ADMIN de un objetivo activo; blockUser()
   * incondicionalmente). Bloquea la fila del Role ADMIN con
   * `SELECT ... FOR UPDATE` dentro de la MISMA transacción — nunca abre una
   * transacción propia, nunca libera el lock antes del commit/rollback del
   * llamador.
   *
   * Por qué el Role ADMIN y no un advisory lock, SERIALIZABLE o una tabla
   * nueva (decisión de producto ya cerrada, no revisitada aquí): Role.name
   * es único y ADMIN es una fila estable del sistema (nunca se borra, nunca
   * cambia de id) — sirve como punto de serialización natural sin
   * infraestructura adicional. Toda transacción que pueda quitar el último
   * ADMIN activo debe pasar por AQUÍ antes de leer o decidir nada sobre el
   * estado de usuarios/roles: cualquier otra transacción concurrente que
   * también llame a este método sobre la misma fila queda esperando hasta
   * que la primera confirme o revierta, así que el COUNT posterior nunca ve
   * un estado a punto de cambiar por una operación hermana en vuelo.
   *
   * Falla cerrado: si la fila ADMIN no existe, es una violación de un
   * invariante interno (el seed y la migración garantizan su existencia),
   * nunca un 400/404 de cliente — mismo criterio que
   * SequenceAdminService.updateSequence() ante una secuencia inexistente.
   */
  private async lockAdminRoleForUpdate(
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id
      FROM roles
      WHERE name = ${RoleName.ADMIN}::"RoleName"
      FOR UPDATE
    `);
    const adminRole = rows[0];
    if (adminRole === undefined) {
      throw new InternalServerErrorException(
        'El rol ADMIN no existe: invariante del sistema violada',
      );
    }
    return adminRole.id;
  }

  /**
   * Cuenta usuarios ACTIVE con ADMIN entre sus roles asignados. Debe
   * invocarse SIEMPRE después de lockAdminRoleForUpdate() dentro de la
   * misma transacción — de lo contrario el resultado puede quedar obsoleto
   * antes de usarse (la razón de ser de este remediation). `some` evita
   * contar dos veces a un usuario con más de un UserRole hacia ADMIN (no
   * es posible por el `@@unique([userId, roleId])` de UserRole, pero
   * `some` es correcto de cualquier forma: nunca se une con `user_roles`
   * fila por fila).
   */
  private async countActiveAdmins(
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.user.count({
      where: {
        status: UserStatus.ACTIVE,
        roles: { some: { role: { name: RoleName.ADMIN } } },
      },
    });
  }

  /** Resuelve cada RoleName a su Role.id real; 400 si alguno no existe. */
  private async resolveRoleIds(
    tx: Prisma.TransactionClient,
    roleNames: RoleName[],
  ): Promise<string[]> {
    const roles = await Promise.all(
      roleNames.map((name) => tx.role.findUnique({ where: { name } })),
    );
    return roles.map((role, index) => {
      if (role === null) {
        throw new BadRequestException(`El rol ${roleNames[index]} no existe`);
      }
      return role.id;
    });
  }

  private assertPasswordPolicy(password: string): void {
    const result = checkPasswordPolicy(password);
    if (!result.valid) {
      throw new BadRequestException(
        `La contraseña no cumple la política: ${result.violations.join(', ')}.`,
      );
    }
  }

  /** Genera una contraseña temporal aleatoria que cumple la política vigente. */
  private generateTemporaryPassword(): string {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let candidate = '';
      for (let i = 0; i < TEMPORARY_PASSWORD_LENGTH; i++) {
        candidate +=
          TEMPORARY_PASSWORD_CHARSET[
            randomInt(TEMPORARY_PASSWORD_CHARSET.length)
          ];
      }
      if (checkPasswordPolicy(candidate).valid) {
        return candidate;
      }
    }
    throw new Error('No fue posible generar una contraseña temporal válida');
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
