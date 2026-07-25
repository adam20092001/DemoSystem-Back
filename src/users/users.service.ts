import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RoleName, UserStatus } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { checkPasswordPolicy } from '../common/security/password-policy';
import { PasswordService } from '../common/security/password.service';
import { PrismaService } from '../database/prisma.service';
import { toSafeUser, USER_SAFE_SELECT } from './mappers/user.mapper';
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

    const username = normalize(input.username);
    const email = normalize(input.email);
    const passwordHash = await this.passwordService.hash(
      input.temporaryPassword,
    );

    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({
        where: { name: input.roleName },
      });
      if (role === null) {
        throw new BadRequestException(`El rol ${input.roleName} no existe`);
      }

      const created = await tx.user.create({
        data: {
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          username,
          email,
          passwordHash,
          roleId: role.id,
          status: UserStatus.ACTIVE,
          mustChangePassword: true,
          failedLoginAttempts: 0,
        },
        select: USER_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'USERS',
        action: AuditAction.USER_CREATED,
        entityType: 'User',
        entityId: created.id,
        description: `Usuario ${username} creado con rol ${input.roleName}`,
        metadata: { username, email, roleName: input.roleName },
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
      where.role = { name: query.roleName };
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
        select: USER_SAFE_SELECT,
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
      select: USER_SAFE_SELECT,
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
      input.roleName !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar: firstName, lastName, email o roleName',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true, username: true },
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

      let roleName: RoleName | undefined;
      if (input.roleName !== undefined) {
        const role = await tx.role.findUnique({
          where: { name: input.roleName },
        });
        if (role === null) {
          throw new BadRequestException(`El rol ${input.roleName} no existe`);
        }
        data.role = { connect: { id: role.id } };
        updatedFields.push('roleName');
        roleName = input.roleName;
      }

      const updated = await tx.user.update({
        where: { id: input.userId },
        data,
        select: USER_SAFE_SELECT,
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
          ...(roleName !== undefined ? { roleName } : {}),
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
      const target = await tx.user.findUnique({
        where: { id: input.targetUserId },
        select: {
          id: true,
          username: true,
          status: true,
          role: { select: { name: true } },
        },
      });
      if (target === null) {
        throw new NotFoundException('Usuario no encontrado');
      }
      if (target.status === UserStatus.BLOCKED) {
        throw new ConflictException('El usuario ya está bloqueado');
      }

      if (target.role.name === RoleName.ADMIN) {
        const activeAdmins = await tx.user.count({
          where: { role: { name: RoleName.ADMIN }, status: UserStatus.ACTIVE },
        });
        if (activeAdmins <= 1) {
          throw new ConflictException(
            'No es posible bloquear al único administrador activo',
          );
        }
      }

      const blocked = await tx.user.update({
        where: { id: input.targetUserId },
        data: { status: UserStatus.BLOCKED, blockedAt: new Date() },
        select: USER_SAFE_SELECT,
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
        select: USER_SAFE_SELECT,
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
        select: USER_SAFE_SELECT,
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
