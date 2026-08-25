import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { DocumentType, Prisma, RoleName } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditMetadataScalar, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import {
  DOCUMENT_SEQUENCE_SAFE_SELECT,
  toSafeDocumentSequence,
} from './mappers/document-sequence.mapper';
import { SafeDocumentSequence } from './types/safe-document-sequence';
import { UpdateDocumentSequenceInput } from './types/update-document-sequence.input';

const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
]);

/** Fila devuelta por el SELECT ... FOR UPDATE crudo (mismos nombres que DOCUMENT_SEQUENCE_SAFE_SELECT). */
interface LockedSequenceRow {
  id: string;
  documentType: DocumentType;
  prefix: string;
  padding: number;
  currentNumber: number;
  updatedAt: Date;
}

/**
 * Defensa en profundidad: mismo criterio que assertCanReadConfiguration()
 * (ConfigurationService) — @Roles()/RolesGuard ya bloquean esto en la capa
 * HTTP, este chequeo es una segunda línea dentro del servicio. Cualquier rol
 * no contemplado explícitamente falla cerrado.
 */
function assertCanReadSequences(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar las secuencias de documentos',
    );
  }
}

/** Mismo criterio, para el único rol autorizado a escribir. */
function assertCanUpdateSequence(requesterRole: RoleName): void {
  if (requesterRole !== RoleName.ADMIN) {
    throw new ForbiddenException(
      'No tiene permisos para actualizar secuencias de documentos',
    );
  }
}

/**
 * Administración de correlativos (Fase 10, Bloque D). Servicio deliberadamente
 * separado de DocumentSequenceService: `next()` (generación automática desde
 * Quotes/Sales) nunca pasa por aquí, nunca audita, y este servicio nunca se
 * exporta a módulos de negocio — ConfigurationModule solo exporta
 * SettingsReader.
 *
 * Estrategia de concurrencia elegida: SELECT ... FOR UPDATE dentro de una
 * transacción (opción A del plan aprobado), no un UPDATE condicional en un
 * único statement. Se prefiere por ser la más simple de razonar y de
 * distinguir con claridad los dos casos de fallo (fila de secuencia
 * inexistente -> 500 interno, igual que next(); currentNumber solicitado por
 * debajo del valor ya bloqueado -> 409) sin ambigüedad de "cero filas
 * afectadas por cuál motivo". El lock se toma una sola vez y se sostiene
 * hasta el commit/rollback de esta misma transacción: cualquier next()
 * concurrente sobre el mismo documentType (su propio UPDATE ... RETURNING en
 * DocumentSequenceService) debe esperar a que esta transacción libere el
 * lock antes de poder tomar el suyo, así que el valor comparado en el paso 3
 * nunca es un valor obsoleto (no hay ventana entre leer y escribir: ambas
 * ocurren dentro de la misma transacción, sobre la misma fila ya bloqueada).
 */
@Injectable()
export class SequenceAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * No crea filas faltantes: si algún documentType no tiene fila de
   * secuencia, simplemente no aparece en el resultado (es un problema de
   * inicialización/seed, no algo que esta lectura deba resolver
   * silenciosamente). Orden determinístico por documentType ASC.
   */
  async listSequences(
    requesterRole: RoleName,
  ): Promise<SafeDocumentSequence[]> {
    assertCanReadSequences(requesterRole);

    const rows = await this.prisma.documentSequence.findMany({
      select: DOCUMENT_SEQUENCE_SAFE_SELECT,
      orderBy: { documentType: 'asc' },
    });

    return rows.map(toSafeDocumentSequence);
  }

  /**
   * Lee, compara y (si corresponde) actualiza + audita dentro de la misma
   * transacción: un fallo de auditoría revierte la actualización. Un PATCH
   * cuyos valores normalizados coinciden exactamente con los actuales no
   * genera cambio ni auditoría (200 con el recurso sin modificar, sin
   * ejecutar el UPDATE) — mismo criterio que ConfigurationService.
   *
   * Nunca sobrescribe un campo no enviado: `data` solo incluye las claves
   * que realmente cambiaron (actualización parcial real a nivel de Prisma),
   * así que un PATCH de solo prefix/padding jamás puede pisar un
   * currentNumber avanzado por un next() concurrente que haya confirmado
   * antes de que esta transacción tomara su lock.
   */
  async updateSequence(
    input: UpdateDocumentSequenceInput,
  ): Promise<SafeDocumentSequence> {
    assertCanUpdateSequence(input.requesterRole);

    const hasAnyField =
      input.prefix !== undefined ||
      input.padding !== undefined ||
      input.currentNumber !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar: prefix, padding o currentNumber',
      );
    }

    let normalizedPrefix: string | undefined;
    if (input.prefix !== undefined) {
      normalizedPrefix = input.prefix.trim();
      if (normalizedPrefix.length === 0) {
        throw new BadRequestException('prefix no puede estar en blanco');
      }
      if (normalizedPrefix.length > 10) {
        throw new BadRequestException('prefix no puede superar 10 caracteres');
      }
    }

    if (
      input.padding !== undefined &&
      (!Number.isInteger(input.padding) ||
        input.padding < 1 ||
        input.padding > 12)
    ) {
      throw new BadRequestException('padding debe ser un entero entre 1 y 12');
    }

    if (
      input.currentNumber !== undefined &&
      (!Number.isInteger(input.currentNumber) || input.currentNumber < 0)
    ) {
      throw new BadRequestException(
        'currentNumber debe ser un entero mayor o igual que 0',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedSequenceRow[]>(Prisma.sql`
        SELECT
          id,
          document_type AS "documentType",
          prefix,
          padding,
          current_number AS "currentNumber",
          updated_at AS "updatedAt"
        FROM document_sequences
        WHERE document_type = ${input.documentType}::"DocumentType"
        FOR UPDATE
      `);
      const existing = rows[0];
      if (existing === undefined) {
        // Falta de configuración operativa (fila de secuencia inexistente),
        // no un error de validación del cliente: nunca se traduce a 400/404
        // — mismo criterio que DocumentSequenceService.next().
        throw new InternalServerErrorException(
          'No hay una secuencia de documentos configurada para este tipo de documento',
        );
      }

      // No-decrease evaluado contra el valor recién bloqueado (nunca contra
      // una lectura anterior a este lock): garantiza que ningún next()
      // concurrente pueda perderse.
      if (
        input.currentNumber !== undefined &&
        input.currentNumber < existing.currentNumber
      ) {
        throw new ConflictException(
          `currentNumber no puede disminuir: el valor actual es ${existing.currentNumber}`,
        );
      }

      const data: Prisma.DocumentSequenceUpdateInput = {};
      const changedFields: string[] = [];
      const oldValues: Record<string, AuditMetadataScalar> = {};
      const newValues: Record<string, AuditMetadataScalar> = {};

      function markChanged(
        field: string,
        oldValue: AuditMetadataScalar,
        newValue: AuditMetadataScalar,
      ): void {
        changedFields.push(field);
        oldValues[field] = oldValue;
        newValues[field] = newValue;
      }

      if (
        normalizedPrefix !== undefined &&
        normalizedPrefix !== existing.prefix
      ) {
        data.prefix = normalizedPrefix;
        markChanged('prefix', existing.prefix, normalizedPrefix);
      }

      if (input.padding !== undefined && input.padding !== existing.padding) {
        data.padding = input.padding;
        markChanged('padding', existing.padding, input.padding);
      }

      if (
        input.currentNumber !== undefined &&
        input.currentNumber !== existing.currentNumber
      ) {
        data.currentNumber = input.currentNumber;
        markChanged(
          'currentNumber',
          existing.currentNumber,
          input.currentNumber,
        );
      }

      if (changedFields.length === 0) {
        return toSafeDocumentSequence(existing);
      }

      const updated = await tx.documentSequence.update({
        where: { id: existing.id },
        data,
        select: DOCUMENT_SEQUENCE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'CONFIGURATION',
        action: AuditAction.SEQUENCE_UPDATED,
        entityType: 'DocumentSequence',
        entityId: updated.id,
        description: 'Secuencia de documentos actualizada',
        metadata: {
          documentType: input.documentType,
          changedFields,
          oldValues,
          newValues,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeDocumentSequence(updated);
    });
  }
}
