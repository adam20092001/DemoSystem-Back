import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** status nunca se acepta aquí: se administra vía activate/deactivate. */
export class UpdateUnitDto {
  @ApiPropertyOptional({ maxLength: 15 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(15)
  code?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ maxLength: 10 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10)
  @Matches(/^[A-Za-z0-9./-]+$/, {
    message: 'abbreviation solo admite letras, números, punto, guion y barra',
  })
  abbreviation?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowDecimal?: boolean;
}
