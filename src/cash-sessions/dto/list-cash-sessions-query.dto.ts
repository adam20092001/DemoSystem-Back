import { ApiPropertyOptional } from '@nestjs/swagger';
import { CashSessionStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { toStrictBoolean } from '../../common/validators/to-strict-boolean.transform';
import { IsDateOnly } from './is-date-only.decorator';

/**
 * Sin search/sort/orderBy/direction: el orden es fijo (openedAt desc, id
 * desc) en el servicio, mismo criterio que ListPaymentsQueryDto. `userId`
 * es un filtro OPCIONAL solicitado por el cliente — CashSessionsService
 * decide si SELLER queda forzado a su propio ID sin importar este valor
 * (nunca se confía en él para autorización, ver §10/§11 del plan
 * aprobado).
 */
export class ListCashSessionsQueryDto {
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
    format: 'uuid',
    description:
      'Solo tiene efecto para ADMIN/MANAGEMENT. SELLER siempre queda forzado a sus propias sesiones sin importar este valor.',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ enum: CashSessionStatus })
  @IsOptional()
  @IsEnum(CashSessionStatus)
  status?: CashSessionStatus;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-01',
    description:
      'Fecha de negocio America/Lima, límite inferior inclusivo de openedAt.',
  })
  @IsOptional()
  @IsDateOnly()
  openedFrom?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-31',
    description:
      'Fecha de negocio America/Lima, límite superior inclusivo de openedAt.',
  })
  @IsOptional()
  @IsDateOnly()
  openedTo?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-01',
    description:
      'Fecha de negocio America/Lima, límite inferior inclusivo de closedAt.',
  })
  @IsOptional()
  @IsDateOnly()
  closedFrom?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-31',
    description:
      'Fecha de negocio America/Lima, límite superior inclusivo de closedAt.',
  })
  @IsOptional()
  @IsDateOnly()
  closedTo?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'true: differenceAmount <> 0. false: differenceAmount = 0. Sin efecto sobre sesiones sin snapshot de cierre (differenceAmount NULL, p. ej. OPEN): esas nunca coinciden con ninguno de los dos valores — el filtro solo es significativo para sesiones con un intento de cierre ya registrado.',
  })
  @IsOptional()
  @Transform(toStrictBoolean)
  @IsBoolean()
  hasDifference?: boolean;
}
