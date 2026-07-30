import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * status nunca se acepta aquí: toda categoría nace ACTIVE; el estado se
 * administra únicamente vía activate/deactivate.
 */
export class CreateCategoryDto {
  @ApiProperty({ maxLength: 30, example: 'HERRAMIENTAS' })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  code!: string;

  @ApiProperty({ maxLength: 120, example: 'Herramientas' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Categoría padre. Omitir para crear una categoría raíz.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}
