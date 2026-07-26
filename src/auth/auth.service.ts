import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserStatus } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { checkPasswordPolicy } from '../common/security/password-policy';
import { PasswordService } from '../common/security/password.service';
import { EnvironmentVariables } from '../config/env.validation';
import { PrismaService } from '../database/prisma.service';
import { toSafeUser, USER_SAFE_SELECT } from '../users/mappers/user.mapper';
import { SafeUser } from '../users/types/safe-user';
import { TokenService } from './token.service';

export interface LoginInput {
  identifier: string;
  password: string;
  ipAddress?: string | null;
}

export interface LoginResult {
  user: SafeUser;
  token: string;
}

export interface ChangePasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
  ipAddress?: string | null;
}

const GENERIC_CREDENTIALS_MESSAGE = 'Credenciales inválidas';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService<EnvironmentVariables, true>,
  ) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const identifier = normalize(input.identifier);
    const ipAddress = input.ipAddress ?? null;

    const found = await this.prisma.user.findFirst({
      where: { OR: [{ username: identifier }, { email: identifier }] },
      select: {
        id: true,
        passwordHash: true,
        status: true,
        failedLoginAttempts: true,
      },
    });

    if (found === null) {
      await this.auditService.record({
        userId: null,
        module: 'AUTH',
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        description: 'Intento de login con credenciales inválidas',
        metadata: { reason: 'USER_NOT_FOUND' },
        ipAddress,
      });
      throw new UnauthorizedException(GENERIC_CREDENTIALS_MESSAGE);
    }

    if (found.status !== UserStatus.ACTIVE) {
      const reason =
        found.status === UserStatus.BLOCKED ? 'USER_BLOCKED' : 'USER_INACTIVE';
      await this.auditService.record({
        userId: found.id,
        module: 'AUTH',
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: found.id,
        description: 'Intento de login con una cuenta no activa',
        metadata: { reason },
        ipAddress,
      });
      throw new UnauthorizedException(GENERIC_CREDENTIALS_MESSAGE);
    }

    const passwordMatches = await this.passwordService.verify(
      found.passwordHash,
      input.password,
    );

    if (!passwordMatches) {
      await this.registerFailedAttempt(
        found.id,
        found.failedLoginAttempts,
        ipAddress,
      );
      throw new UnauthorizedException(GENERIC_CREDENTIALS_MESSAGE);
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: found.id },
        data: {
          failedLoginAttempts: 0,
          blockedAt: null,
          lastLoginAt: new Date(),
        },
        select: USER_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: found.id,
        module: 'AUTH',
        action: AuditAction.LOGIN_SUCCESS,
        entityType: 'User',
        entityId: found.id,
        description: `Login exitoso de ${updated.username}`,
        metadata: { username: updated.username },
        ipAddress,
        client: tx,
      });

      return updated;
    });

    const token = await this.tokenService.sign(found.id);

    return { user: toSafeUser(user), token };
  }

  async changePassword(input: ChangePasswordInput): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, username: true, passwordHash: true },
    });
    if (user === null) {
      throw new UnauthorizedException(GENERIC_CREDENTIALS_MESSAGE);
    }

    const currentMatches = await this.passwordService.verify(
      user.passwordHash,
      input.currentPassword,
    );
    if (!currentMatches) {
      throw new UnauthorizedException(GENERIC_CREDENTIALS_MESSAGE);
    }

    const policyResult = checkPasswordPolicy(input.newPassword);
    if (!policyResult.valid) {
      throw new BadRequestException(
        `La nueva contraseña no cumple la política: ${policyResult.violations.join(', ')}.`,
      );
    }

    const sameAsCurrent = await this.passwordService.verify(
      user.passwordHash,
      input.newPassword,
    );
    if (sameAsCurrent) {
      throw new BadRequestException(
        'La nueva contraseña debe ser diferente de la actual',
      );
    }

    const passwordHash = await this.passwordService.hash(input.newPassword);
    const ipAddress = input.ipAddress ?? null;

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: input.userId },
        data: {
          passwordHash,
          mustChangePassword: false,
          failedLoginAttempts: 0,
        },
      });

      await this.auditService.record({
        userId: input.userId,
        module: 'AUTH',
        action: AuditAction.PASSWORD_CHANGED,
        entityType: 'User',
        entityId: input.userId,
        description: `Contraseña actualizada por ${user.username}`,
        metadata: { username: user.username },
        ipAddress,
        client: tx,
      });
    });
  }

  /**
   * Incrementa el contador de intentos fallidos y bloquea la cuenta al
   * alcanzar MAX_LOGIN_ATTEMPTS. La actualización y la auditoría comparten
   * transacción.
   */
  private async registerFailedAttempt(
    userId: string,
    currentAttempts: number,
    ipAddress: string | null,
  ): Promise<void> {
    const maxAttempts = this.configService.get('MAX_LOGIN_ATTEMPTS', {
      infer: true,
    });
    const nextAttempts = currentAttempts + 1;
    const shouldBlock = nextAttempts >= maxAttempts;

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          failedLoginAttempts: nextAttempts,
          ...(shouldBlock
            ? { status: UserStatus.BLOCKED, blockedAt: new Date() }
            : {}),
        },
      });

      await this.auditService.record({
        userId,
        module: 'AUTH',
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: userId,
        description: shouldBlock
          ? 'Usuario bloqueado tras superar los intentos de login permitidos'
          : 'Contraseña incorrecta',
        metadata: { reason: 'INVALID_PASSWORD' },
        ipAddress,
        client: tx,
      });
    });
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
