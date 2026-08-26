import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoleName, UserStatus } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { checkPasswordPolicy } from '../common/security/password-policy';
import { PasswordService } from '../common/security/password.service';
import { EnvironmentVariables } from '../config/env.validation';
import { PrismaService } from '../database/prisma.service';
import {
  hasAssignedRole,
  toSafeUser,
  USER_WITH_ROLES_SELECT,
} from '../users/mappers/user.mapper';
import { resolveDefaultActiveRole } from './default-active-role';
import { AccountBlockedException } from './exceptions/account-blocked.exception';
import { AuthSessionUser } from './types/auth-session-user';
import { TokenService } from './token.service';

export interface LoginInput {
  identifier: string;
  password: string;
  ipAddress?: string | null;
}

export interface LoginResult {
  user: AuthSessionUser;
  token: string;
}

export interface ChangePasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
  ipAddress?: string | null;
}

export interface SwitchRoleInput {
  userId: string;
  /** activeRole ya validado en vivo de ESTA sesión (JwtAuthGuard), nunca del body. */
  currentActiveRole: RoleName;
  requestedRole: RoleName;
  ipAddress?: string | null;
}

export interface SwitchRoleResult {
  user: AuthSessionUser;
  /**
   * `null` únicamente en el no-op de mismo rol (KAN-18, Bloque B, §9 del
   * kickoff aprobado): ni se firma un JWT nuevo ni el controller debe
   * reemplazar la cookie de sesión. Cuando el cambio es real, siempre trae
   * el nuevo token firmado.
   */
  token: string | null;
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

    // La contraseña se verifica ANTES de mirar el status: revelar que una
    // cuenta está BLOCKED/INACTIVE a quien todavía no demostró conocer la
    // contraseña equivaldría a confirmar que la cuenta existe y su estado.
    const passwordMatches = await this.passwordService.verify(
      found.passwordHash,
      input.password,
    );

    if (!passwordMatches) {
      if (found.status === UserStatus.ACTIVE) {
        // Único caso que cuenta intentos y puede bloquear: una cuenta ya
        // BLOCKED o INACTIVE no tiene contador que incrementar ni acción
        // adicional que tomar más allá de auditar el intento.
        await this.registerFailedAttempt(
          found.id,
          found.failedLoginAttempts,
          ipAddress,
        );
      } else {
        await this.auditService.record({
          userId: found.id,
          module: 'AUTH',
          action: AuditAction.LOGIN_FAILED,
          entityType: 'User',
          entityId: found.id,
          description: 'Contraseña incorrecta',
          metadata: { reason: 'INVALID_PASSWORD' },
          ipAddress,
        });
      }
      throw new UnauthorizedException(GENERIC_CREDENTIALS_MESSAGE);
    }

    // A partir de aquí la contraseña es correcta: recién ahora es seguro
    // distinguir el estado de la cuenta en la respuesta.
    if (found.status === UserStatus.BLOCKED) {
      await this.auditService.record({
        userId: found.id,
        module: 'AUTH',
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: found.id,
        description: 'Intento de login sobre una cuenta bloqueada',
        metadata: { reason: 'USER_BLOCKED' },
        ipAddress,
      });
      throw new AccountBlockedException();
    }

    if (found.status === UserStatus.INACTIVE) {
      await this.auditService.record({
        userId: found.id,
        module: 'AUTH',
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: found.id,
        description: 'Intento de login sobre una cuenta inactiva',
        metadata: { reason: 'USER_INACTIVE' },
        ipAddress,
      });
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
        select: USER_WITH_ROLES_SELECT,
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

    // KAN-18, Bloque A: el rol activo se resuelve con el orden determinista
    // aprobado (SELLER > WAREHOUSE > MANAGEMENT > ADMIN) y nunca se persiste
    // como "último usado" — cada login lo vuelve a resolver desde cero.
    const safeUser = toSafeUser(user);
    const activeRole = resolveDefaultActiveRole(safeUser.roles);
    const token = await this.tokenService.sign(found.id, activeRole);

    return { user: { ...safeUser, activeRole }, token };
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
   * KAN-18, Bloque B: cambia únicamente el rol ACTIVO de ESTA sesión — nunca
   * los roles asignados (UserRole no se toca). El actor y su `currentActiveRole`
   * llegan ya resueltos por JwtAuthGuard (nunca del cuerpo de la petición);
   * este método siempre relee al usuario y sus roles asignados en vivo desde
   * PostgreSQL, nunca confía en el JWT ni en el estado del frontend.
   *
   * No hay ninguna escritura persistente que revertir (nunca se abre
   * `$transaction`): el único efecto observable de un cambio real es la
   * auditoría + el nuevo JWT, y ambos deben aparecer juntos o ninguno. Por
   * eso el JWT se firma EN MEMORIA primero y la auditoría se registra
   * después, pero el método nunca devuelve el token al controller hasta que
   * la auditoría se confirma: si tokenService.sign() falla, nunca se llega
   * a auditar (nunca existe un evento ACTIVE_ROLE_SWITCHED para un cambio
   * que no pudo producir sesión); si auditService.record() falla, la
   * excepción se propaga igual y el token firmado en memoria nunca se
   * devuelve, así que el controller nunca puede exponerlo ni reemplazar la
   * cookie de una sesión sin auditar.
   */
  async switchRole(input: SwitchRoleInput): Promise<SwitchRoleResult> {
    // Defensa en profundidad (mismo criterio que changePassword()): el
    // JwtAuthGuard global ya garantiza status=ACTIVE para la petición en
    // curso, pero este método nunca confía únicamente en esa verificación
    // previa — nunca debe emitirse un token nuevo para un usuario ausente o
    // no-ACTIVE, sin importar cuán improbable sea la carrera.
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: USER_WITH_ROLES_SELECT,
    });
    if (user === null || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException(GENERIC_CREDENTIALS_MESSAGE);
    }

    // El rol solicitado se valida SIEMPRE contra la asignación vigente en
    // PostgreSQL — nunca contra roles almacenados en el frontend, en una
    // respuesta anterior, ni en el activeRole del JWT actual.
    if (!hasAssignedRole(user, input.requestedRole)) {
      throw new ForbiddenException(
        'El rol solicitado no está asignado a este usuario',
      );
    }

    const safeUser = toSafeUser(user);

    // No-op cerrado (KAN-18, Bloque B, §9): mismo rol ya asignado y ya
    // activo -> 200 con la sesión actual, sin JWT nuevo, sin reemplazo de
    // cookie, sin evento de auditoría. Nunca se fabrica un "cambio" que en
    // los hechos no ocurrió.
    if (input.requestedRole === input.currentActiveRole) {
      return {
        user: { ...safeUser, activeRole: input.requestedRole },
        token: null,
      };
    }

    // Orden deliberado (KAN-18, remediación final de Bloque B): el JWT se
    // firma EN MEMORIA antes de auditar, pero nunca se devuelve al
    // controller (ni, por lo tanto, nunca reemplaza la cookie) hasta que la
    // auditoría se confirma. Esto cierra los dos casos de falla posibles:
    // - Si tokenService.sign() falla, nunca se llega a auditar: jamás existe
    //   un evento ACTIVE_ROLE_SWITCHED para un cambio que no pudo producir
    //   una sesión nueva.
    // - Si auditService.record() falla (con el token ya firmado en memoria),
    //   la excepción se propaga igual: el token nunca se devuelve, así que
    //   el controller nunca puede exponerlo ni fijarlo en la cookie. El
    //   único efecto observable de "éxito" sigue siendo, como antes,
    //   auditoría + token juntos o ninguno de los dos.
    const token = await this.tokenService.sign(user.id, input.requestedRole);

    await this.auditService.record({
      userId: user.id,
      module: 'AUTH',
      action: AuditAction.ACTIVE_ROLE_SWITCHED,
      entityType: 'User',
      entityId: user.id,
      description: `Rol activo cambiado de ${input.currentActiveRole} a ${input.requestedRole} para ${user.username}`,
      metadata: {
        fromRole: input.currentActiveRole,
        toRole: input.requestedRole,
      },
      ipAddress: input.ipAddress ?? null,
    });

    return {
      user: { ...safeUser, activeRole: input.requestedRole },
      token,
    };
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
