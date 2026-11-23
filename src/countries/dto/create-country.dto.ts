import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/** Alta de un país en el catálogo compartido (ADMIN, PURCHASING). */
export class CreateCountryDto {
  @ApiProperty({
    example: 'BR',
    description:
      'Código ISO 3166-1 alpha-2 (2 letras; se normaliza a mayúsculas).',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{2}$/, {
    message: 'code debe ser un código de país de 2 letras (ISO 3166-1 alpha-2)',
  })
  code!: string;

  @ApiProperty({ example: 'Brasil', maxLength: 100 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;
}
