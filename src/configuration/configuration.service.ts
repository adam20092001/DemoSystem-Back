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
  COMPANY_SETTINGS_POS_SAFE_SELECT,
  COMPANY_SETTINGS_SAFE_SELECT,
  toSafeCompanySettings,
  toSafePosCompanySettings,
} from './mappers/company-settings.mapper';
import { SafeCompanySettings } from './types/safe-company-settings';
import { SafePosCompanySettings } from './types/safe-pos-company-settings';
import { UpdateConfigurationInput } from './types/update-configuration.input';

/** ISO 4217: exactamente 3 letras mayúsculas. */
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/**
 * Decimal(5,2) no negativo, hasta 3 dígitos enteros (cubre "100.00"),
 * máximo 2 decimales. Compartido por maxDiscountPercent (Bloque B) y
 * taxRate (Bloque C): mismo shape de columna, nunca un segundo formato.
 */
const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

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

/**
 * Ticket A post-MVP: surface de solo lectura para POS. Roles distintos de
 * assertCanReadConfiguration() a propósito — SELLER puede leer el recorte
 * POS pero sigue sin poder leer (ni mucho menos escribir) la configuración
 * administrativa completa. Mismo criterio de "cero consultas para un rol
 * sin acceso" y "falla cerrado ante cualquier rol no contemplado
 * explícitamente" que el resto de este archivo.
 */
const POS_READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.SELLER,
]);

function assertCanReadPosConfiguration(requesterRole: RoleName): void {
  if (!POS_READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar la configuración comercial del punto de venta',
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
   * Ticket A post-MVP: configuración comercial de solo lectura para POS.
   * Consulta con un `select` propio (COMPANY_SETTINGS_POS_SAFE_SELECT) que
   * pide exactamente los 9 campos aprobados — nunca el registro completo
   * seguido de un recorte en memoria, así un campo administrativo agregado
   * en el futuro a CompanySettings no llega ni siquiera a esta consulta.
   */
  async getPosConfiguration(
    requesterRole: RoleName,
  ): Promise<SafePosCompanySettings> {
    assertCanReadPosConfiguration(requesterRole);

    const row = await this.prisma.companySettings.findUnique({
      where: { singleton: true },
      select: COMPANY_SETTINGS_POS_SAFE_SELECT,
    });
    if (row === null) {
      throw new InternalServerErrorException(
        'Configuración de la empresa no inicializada: falta la fila singleton de company_settings',
      );
    }
    return toSafePosCompanySettings(row);
  }

  /**
   * Bloque A: campos de identidad y moneda. Bloque B (Fase 10): se agregan
   * quoteValidityDays/maxDiscountPercent. Bloque C: se agregan taxEnabled/
   * taxRate — con esto los 10 campos editables aprobados quedan activos,
   * ninguno permanece bloqueado.
   *
   * Lee, compara y (si corresponde) actualiza + audita dentro de la misma
   * transacción: un fallo de auditoría revierte la actualización. Un PATCH
   * cuyos valores normalizados coinciden exactamente con los actuales no
   * genera cambio ni auditoría (200 con el recurso sin modificar, sin
   * ejecutar el UPDATE).
   *
   * changedFields/oldValues/newValues se construyen aquí mismo, campo por
   * campo, siempre a partir de la whitelist cerrada de los 10 campos
   * editables (8 del Bloque A + 2 del Bloque B + 2 del Bloque C) — nunca
   * del body crudo de la petición. El saneador de auditoría
   * (sanitizeAuditMetadata) impone además, como defensa independiente, que
   * ninguna clave sobreviva dentro de oldValues/newValues si no figura en
   * changedFields. Cambiar estos valores nunca modifica cotizaciones/ventas
   * ya existentes (sin backfill, sin recálculo al leer, sin actualización
   * programada): solo afecta operaciones comerciales nuevas o
   * efectivamente modificadas a partir de este momento (ver
   * QuotesService/SalesService).
   *
   * Invariante cruzada IGV (§8 del plan aprobado): el estado RESULTANTE
   * debe cumplir taxEnabled=false, o taxRate > 0 — evaluada sobre el par
   * final (existente + lo enviado), nunca solo sobre los campos presentes
   * en el body. Se valida ANTES de escribir nada; si falla, no hay UPDATE
   * ni auditoría.
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
      input.currencySymbol !== undefined ||
      input.quoteValidityDays !== undefined ||
      input.maxDiscountPercent !== undefined ||
      input.taxEnabled !== undefined ||
      input.taxRate !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar: businessName, tradeName, taxId, address, phone, email, currencyCode, currencySymbol, quoteValidityDays, maxDiscountPercent, taxEnabled o taxRate',
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

      if (input.quoteValidityDays !== undefined) {
        if (
          !Number.isInteger(input.quoteValidityDays) ||
          input.quoteValidityDays <= 0
        ) {
          throw new BadRequestException(
            'quoteValidityDays debe ser un entero mayor que cero',
          );
        }
        if (input.quoteValidityDays !== existing.quoteValidityDays) {
          data.quoteValidityDays = input.quoteValidityDays;
          markChanged(
            'quoteValidityDays',
            existing.quoteValidityDays,
            input.quoteValidityDays,
          );
        }
      }

      if (input.maxDiscountPercent !== undefined) {
        if (!PERCENT_PATTERN.test(input.maxDiscountPercent)) {
          throw new BadRequestException(
            'maxDiscountPercent debe ser un decimal no negativo, como texto, con máximo 2 decimales',
          );
        }
        const maxDiscountPercent = new Prisma.Decimal(input.maxDiscountPercent);
        if (
          maxDiscountPercent.lessThan(0) ||
          maxDiscountPercent.greaterThan(100)
        ) {
          throw new BadRequestException(
            'maxDiscountPercent debe estar entre 0.00 y 100.00',
          );
        }
        if (!maxDiscountPercent.equals(existing.maxDiscountPercent)) {
          data.maxDiscountPercent = maxDiscountPercent;
          // Auditoría siempre como string de 2 decimales fijos (§23 del
          // plan aprobado), nunca el Decimal crudo ni un number de JS.
          markChanged(
            'maxDiscountPercent',
            existing.maxDiscountPercent.toFixed(2),
            maxDiscountPercent.toFixed(2),
          );
        }
      }

      // resultingTaxEnabled/resultingTaxRate: arrancan en el valor YA
      // persistido y se actualizan solo si el campo correspondiente viene
      // en el body — así la invariante cruzada de abajo siempre evalúa el
      // par FINAL resultante, nunca solo los campos presentes en el PATCH.
      let resultingTaxEnabled = existing.taxEnabled;
      let resultingTaxRate = existing.taxRate;

      if (input.taxEnabled !== undefined) {
        resultingTaxEnabled = input.taxEnabled;
        if (input.taxEnabled !== existing.taxEnabled) {
          data.taxEnabled = input.taxEnabled;
          markChanged('taxEnabled', existing.taxEnabled, input.taxEnabled);
        }
      }

      if (input.taxRate !== undefined) {
        if (!PERCENT_PATTERN.test(input.taxRate)) {
          throw new BadRequestException(
            'taxRate debe ser un decimal no negativo, como texto, con máximo 2 decimales',
          );
        }
        const taxRate = new Prisma.Decimal(input.taxRate);
        if (taxRate.lessThan(0) || taxRate.greaterThan(100)) {
          throw new BadRequestException(
            'taxRate debe estar entre 0.00 y 100.00',
          );
        }
        resultingTaxRate = taxRate;
        if (!taxRate.equals(existing.taxRate)) {
          data.taxRate = taxRate;
          // Auditoría siempre como string de 2 decimales fijos (mismo
          // criterio que maxDiscountPercent), nunca el Decimal crudo.
          markChanged(
            'taxRate',
            existing.taxRate.toFixed(2),
            taxRate.toFixed(2),
          );
        }
      }

      // Invariante cruzada IGV (§8 del plan aprobado): taxEnabled=true
      // exige taxRate > 0 en el estado RESULTANTE. Se valida antes de
      // escribir nada; un rechazo aquí no genera UPDATE ni auditoría.
      if (resultingTaxEnabled && resultingTaxRate.lessThanOrEqualTo(0)) {
        throw new BadRequestException(
          'taxRate debe ser mayor que 0 cuando taxEnabled es true',
        );
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
