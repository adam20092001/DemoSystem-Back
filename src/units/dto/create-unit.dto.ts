import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** status nunca se acepta aquí: toda unidad nace ACTIVE. */
export class CreateUnitDto {
  @ApiProperty({ maxLength: 15, example: 'KG' })
  @IsString()
  @MinLength(1)
  @MaxLength(15)
  code!: string;

  @ApiProperty({ maxLength: 60, example: 'Kilogramo' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiProperty({ maxLength: 10, example: 'kg' })
  @IsString()
  @MinLength(1)
  @MaxLength(10)
  @Matches(/^[A-Za-z0-9./-]+$/, {
    message: 'abbreviation solo admite letras, números, punto, guion y barra',
  })
  abbreviation!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  allowDecimal?: boolean;
}
