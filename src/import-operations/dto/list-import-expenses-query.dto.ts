import { ApiPropertyOptional } from '@nestjs/swagger';
import { ImportExpenseCategory, ImportExpenseStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListImportExpensesQueryDto {
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

  @ApiPropertyOptional({ enum: ImportExpenseCategory })
  @IsOptional()
  @IsEnum(ImportExpenseCategory)
  category?: ImportExpenseCategory;

  @ApiPropertyOptional({ enum: ImportExpenseStatus })
  @IsOptional()
  @IsEnum(ImportExpenseStatus)
  status?: ImportExpenseStatus;
}
