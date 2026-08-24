import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditMetadataScalar, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import {
  COMPANY_SETTINGS_SAFE_SELECT,
  toSafeCompanySettings,
} from './mappers/company-settings.mapper';
import { SafeCompanySettings } from './types/safe-company-settings';
import { UpdateConfigurationInput } from './types/update-configuration.input';

/** ISO 4217: exactamente 3 letras mayúsculas. */
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
]);

/**
 * Defensa en profundidad: mismo criterio de "cero consultas para un rol sin
 * acceso" que resolveSectionVisibility() en DashboardService, adaptado a un
 * recurso único de todo-o-nada (no una composición de secciones parciales).
 * @Roles()/RolesGuard ya bloquean esto en la capa HTTP; este chequeo es una
 * segunda línea de defensa dentro del servicio — nunca se confía únicamente
 * en el guard. Cualquier rol no contemplado explícitamente (incluido un
 * valor fuera del enum conocido) falla cerrado.
 */
function assertCanReadConfiguration(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar la configuración de la empresa',
    );
  }
}

/** Mismo criterio que assertCanReadConfiguration(), para el único rol autorizado a escribir. */
function assertCanUpdateConfiguration(requesterRole: RoleName): void {
  if (requesterRole !== RoleName.ADMIN) {
    throw new ForbiddenException(
      'No tiene permisos para actualizar la configuración de la empresa',
    );
  }
}

@Injectable()
export class ConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async getConfiguration(
    requesterRole: RoleName,
  ): Promise<SafeCompanySettings> {
    assertCanReadConfiguration(requesterRole);

    const row = await this.prisma.companySettings.findUnique({
      where: { singleton: true },
      select: COMPANY_SETTINGS_SAFE_SELECT,
    });
    if (row === null) {
      throw new InternalServerErrorException(
        'Configuración de la empresa no inicializada: falta la fila singleton de company_settings',
      );
    }
    return toSafeCompanySettings(row);
  }

  /**
   * Bloque A: solo campos de identidad y moneda. taxEnabled/taxRate/
   * quoteValidityDays/maxDiscountPercent nunca llegan aquí — el DTO del
   * controller no los declara y el ValidationPipe global
   * (forbidNonWhitelisted) ya rechazó la petición con 400 antes de este
   * punto si el cliente los envió.
   *
   * Lee, compara y (si corresponde) actualiza + audita dentro de la misma
   * transacción: un fallo de auditoría revierte la actualización. Un PATCH
   * cuyos valores normalizados coinciden exactamente con los actuales no
   * genera cambio ni auditoría (200 con el recurso sin modificar, sin
   * ejecutar el UPDATE).
   *
   * changedFields/oldValues/newValues se construyen aquí mismo, campo por
   * campo, siempre a partir de la whitelist cerrada de los 8 campos
   * editables del Bloque A — nunca del body crudo de la petición. El
   * saneador de auditoría (sanitizeAuditMetadata) impone además, como
   * defensa independiente, que ninguna clave sobreviva dentro de
   * oldValues/newValues si no figura en changedFields.
   */
  async updateConfiguration(
    input: UpdateConfigurationInput,
  ): Promise<SafeCompanySettings> {
    assertCanUpdateConfiguration(input.requesterRole);

    const hasAnyField =
      input.businessName !== undefined ||
      input.tradeName !== undefined ||
      input.taxId !== undefined ||
      input.address !== undefined ||
      input.phone !== undefined ||
      input.email !== undefined ||
      input.currencyCode !== undefined ||
      input.currencySymbol !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar: businessName, tradeName, taxId, address, phone, email, currencyCode o currencySymbol',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.companySettings.findUnique({
        where: { singleton: true },
        select: COMPANY_SETTINGS_SAFE_SELECT,
      });
      if (existing === null) {
        throw new InternalServerErrorException(
          'Configuración de la empresa no inicializada: falta la fila singleton de company_settings',
        );
      }

      const data: Prisma.CompanySettingsUpdateInput = {};
      const changedFields: string[] = [];
      const oldValues: Record<string, AuditMetadataScalar> = {};
      const newValues: Record<string, AuditMetadataScalar> = {};

      /** Registra un campo como realmente cambiado en las 3 estructuras a la vez. */
      function markChanged(
        field: string,
        oldValue: AuditMetadataScalar,
        newValue: AuditMetadataScalar,
      ): void {
        changedFields.push(field);
        oldValues[field] = oldValue;
        newValues[field] = newValue;
      }

      if (input.businessName !== undefined) {
        const businessName = input.businessName.trim();
        if (businessName.length === 0) {
          throw new BadRequestException(
            'businessName no puede estar en blanco',
          );
        }
        if (businessName !== existing.businessName) {
          data.businessName = businessName;
          markChanged('businessName', existing.businessName, businessName);
        }
      }

      if (input.tradeName !== undefined) {
        const tradeName = normalizeNullableText(input.tradeName);
        if (tradeName !== existing.tradeName) {
          data.tradeName = tradeName;
          markChanged('tradeName', existing.tradeName, tradeName);
        }
      }

      if (input.taxId !== undefined) {
        const taxId = normalizeNullableText(input.taxId);
        if (taxId !== existing.taxId) {
          data.taxId = taxId;
          markChanged('taxId', existing.taxId, taxId);
        }
      }

      if (input.address !== undefined) {
        const address = normalizeNullableText(input.address);
        if (address !== existing.address) {
          data.address = address;
          markChanged('address', existing.address, address);
        }
      }

      if (input.phone !== undefined) {
        const phone = normalizeNullableText(input.phone);
        if (phone !== existing.phone) {
          data.phone = phone;
          markChanged('phone', existing.phone, phone);
        }
      }

      if (input.email !== undefined) {
        const email = normalizeNullableText(input.email);
        if (email !== existing.email) {
          data.email = email;
          markChanged('email', existing.email, email);
        }
      }

      if (input.currencyCode !== undefined) {
        const currencyCode = input.currencyCode.trim().toUpperCase();
        if (!CURRENCY_CODE_PATTERN.test(currencyCode)) {
          throw new BadRequestException(
            'currencyCode debe tener exactamente 3 letras (ISO 4217), p. ej. PEN',
          );
        }
        if (currencyCode !== existing.currencyCode) {
          data.currencyCode = currencyCode;
          markChanged('currencyCode', existing.currencyCode, currencyCode);
        }
      }

      if (input.currencySymbol !== undefined) {
        const currencySymbol = input.currencySymbol.trim();
        if (currencySymbol.length === 0 || currencySymbol.length > 5) {
          throw new BadRequestException(
            'currencySymbol debe tener entre 1 y 5 caracteres tras eliminar espacios',
          );
        }
        if (currencySymbol !== existing.currencySymbol) {
          data.currencySymbol = currencySymbol;
          markChanged(
            'currencySymbol',
            existing.currencySymbol,
            currencySymbol,
          );
        }
      }

      if (changedFields.length === 0) {
        return toSafeCompanySettings(existing);
      }

      const updated = await tx.companySettings.update({
        where: { singleton: true },
        data,
        select: COMPANY_SETTINGS_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'CONFIGURATION',
        action: AuditAction.CONFIGURATION_UPDATED,
        entityType: 'CompanySettings',
        entityId: updated.id,
        description: 'Configuración de la empresa actualizada',
        metadata: { changedFields, oldValues, newValues },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeCompanySettings(updated);
    });
  }
}

/** trim(); cadena vacía tras el trim se convierte en null (limpia el campo). */
function normalizeNullableText(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
