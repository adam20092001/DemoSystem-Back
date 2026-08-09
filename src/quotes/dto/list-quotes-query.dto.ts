import { ApiPropertyOptional } from '@nestjs/swagger';
import { QuoteStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsDateOnly } from './create-quote.dto';

/** Sin orderBy/sort/direction: el orden es fijo (createdAt desc, id desc) en el servicio. */
export class ListQuotesQueryDto {
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
    enum: QuoteStatus,
    description:
      'Estado EFECTIVO solicitado (EXPIRED se traduce a fecha vencida sin exigir que esté persistido).',
  })
  @IsOptional()
  @IsEnum(QuoteStatus)
  status?: QuoteStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sellerId?: string;

  @ApiPropertyOptional({ type: String, example: '2026-01-01' })
  @IsOptional()
  @IsDateOnly()
  issueDateFrom?: string;

  @ApiPropertyOptional({ type: String, example: '2026-01-31' })
  @IsOptional()
  @IsDateOnly()
  issueDateTo?: string;

  @ApiPropertyOptional({ type: String, example: '2026-02-01' })
  @IsOptional()
  @IsDateOnly()
  expirationDateFrom?: string;

  @ApiPropertyOptional({ type: String, example: '2026-02-28' })
  @IsOptional()
  @IsDateOnly()
  expirationDateTo?: string;

  @ApiPropertyOptional({
    maxLength: 150,
    description:
      'Búsqueda por number/customerName/customerDocumentNumber (insensible a mayúsculas).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  search?: string;
}
