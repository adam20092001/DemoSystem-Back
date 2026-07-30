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
  @IsString()
  @MinLength(1)
  @MaxLength(15)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10)
  @Matches(/^[A-Za-z0-9./-]+$/, {
    message: 'abbreviation solo admite letras, números, punto, guion y barra',
  })
  abbreviation!: string;

  @IsOptional()
  @IsBoolean()
  allowDecimal?: boolean;
}
