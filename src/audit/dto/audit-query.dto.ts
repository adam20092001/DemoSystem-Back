import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { AuditAction } from '../audit-action.enum';
import { AUDIT_MODULES } from '../audit-module.constants';
import type { AuditModuleName } from '../audit-module.constants';
import { IsDateOnly } from './is-date-only.decorator';

/**
 * Recorta espacios perimetrales antes de validar longitud/blanco — mismo
 * criterio que trimEmail en UpdateConfigurationDto: sin esto, "  X  " pasaría
 * @MinLength(1) por no estar vacío en crudo, y luego se filtraría por un
 * valor con espacios que nunca coincide con lo persistido (trim ya se aplica
 * también al escribir metadata/description, nunca a entityId/entityType en
 * escritura, pero el filtro de lectura sí debe tolerar espacios accidentales
 * del cliente).
 */
function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * GET /audit (Fase 10, Bloque E). Solo estos 9 campos: page/limit/from/to/
 * userId/module/action/entityType/entityId — el ValidationPipe global
 * (whitelist + forbidNonWhitelisted) rechaza con 400 cualquier otro campo de
 * query, incluido ipAddress (nunca un filtro público) y cualquier alias.
 *
 * Sin @IsEnum(AuditAction)/@IsIn(AUDIT_MODULES) fallando en silencio: ambos
 * decoradores producen 400 explícito ante un valor fuera del conjunto
 * cerrado, nunca un filtro ignorado.
 */
export class AuditQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-01',
    description:
      'Fecha de negocio America/Lima, límite inferior inclusivo de createdAt. El servicio valida from <= to.',
  })
  @IsOptional()
  @IsDateOnly()
  from?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-31',
    description: 'Fecha de negocio America/Lima, límite superior inclusivo.',
  })
  @IsOptional()
  @IsDateOnly()
  to?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    enum: AUDIT_MODULES,
    description: 'Conjunto cerrado de módulos auditables existentes.',
  })
  @IsOptional()
  @IsIn(AUDIT_MODULES)
  module?: AuditModuleName;

  @ApiPropertyOptional({ enum: AuditAction })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({
    maxLength: 50,
    example: 'Sale',
    description:
      'Nombre de entidad polimórfico (p. ej. "Sale", "Quote", "CompanySettings"). Sin enum cerrado: la auditoría es polimórfica.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  entityType?: string;

  @ApiPropertyOptional({
    maxLength: 64,
    description:
      'Identificador opaco de la entidad auditada. NO se valida como UUID: es VARCHAR(64) polimórfico (puede ser un UUID de Sale/Quote/etc., pero también otros identificadores opacos existentes en el dominio).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  entityId?: string;
}
