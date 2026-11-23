import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Edición de un país (solo ADMIN). El código es inmutable; activar/desactivar
 * tiene sus propias rutas. `pendingReview=false` confirma un país incorporado
 * desde datos históricos.
 */
export class UpdateCountryDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: 'Solo false (confirmar la revisión de un país histórico).',
  })
  @IsOptional()
  @IsBoolean()
  pendingReview?: boolean;
}
