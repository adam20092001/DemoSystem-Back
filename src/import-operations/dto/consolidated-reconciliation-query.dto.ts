import { ApiPropertyOptional } from '@nestjs/swagger';
import { ImportOperationStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

const RECONCILIATION_STATUSES = [
  'CONSISTENT',
  'PARTIAL_PENDING_OPERATIONAL_LINK',
  'PENDING_ACCOUNTING_POLICY',
  'PENDING_FX',
  'DATA_INCONSISTENCY',
] as const;
type ReconciliationStatusValue = (typeof RECONCILIATION_STATUSES)[number];

export class ConsolidatedReconciliationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  importOperationId?: string;

  @ApiPropertyOptional({ enum: ImportOperationStatus })
  @IsOptional()
  @IsEnum(ImportOperationStatus)
  status?: ImportOperationStatus;

  @ApiPropertyOptional({ enum: RECONCILIATION_STATUSES })
  @IsOptional()
  @IsEnum(RECONCILIATION_STATUSES)
  reconciliationStatus?: ReconciliationStatusValue;

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
}
