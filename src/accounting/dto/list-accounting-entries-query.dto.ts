import { ApiPropertyOptional } from '@nestjs/swagger';
import { AccountingEventType, AccountingSourceType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { IsDateOnly } from './is-date-only.decorator';

/**
 * Sin búsqueda de descripción/accountId/rango de monto/orderBy/direction/
 * balance: el plan cerrado no los incluye (§14 del plan aprobado). Orden
 * fijo en el servicio: createdAt asc, id asc (orden cronológico de libro
 * diario).
 */
export class ListAccountingEntriesQueryDto {
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

  @ApiPropertyOptional({ enum: AccountingSourceType })
  @IsOptional()
  @IsEnum(AccountingSourceType)
  sourceType?: AccountingSourceType;

  @ApiPropertyOptional({ enum: AccountingEventType })
  @IsOptional()
  @IsEnum(AccountingEventType)
  eventType?: AccountingEventType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-01',
    description:
      'Fecha de negocio America/Lima, límite inferior inclusivo de postedAt. El servicio valida postedFrom <= postedTo.',
  })
  @IsOptional()
  @IsDateOnly()
  postedFrom?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-31',
    description: 'Fecha de negocio America/Lima, límite superior inclusivo.',
  })
  @IsOptional()
  @IsDateOnly()
  postedTo?: string;
}
