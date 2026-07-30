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
 * description y parentId aceptan null explícito (limpiar descripción /
 * convertir en raíz) además de undefined (no tocar). @IsOptional() de
 * class-validator omite el resto de validadores cuando el valor es null,
 * así que null siempre pasa la validación sin necesidad de decoradores
 * adicionales. status nunca se acepta aquí.
 */
export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}
