import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { IsDateOnly } from './is-date-only.decorator';

/** "id1,id2,id3" -> ["id1","id2","id3"]; cualquier otra forma pasa intacta para que @IsArray la rechace con un mensaje claro. */
function commaSeparatedToArray({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export class TrialBalanceQueryDto {
  @ApiProperty({
    type: String,
    example: '2026-03-01',
    description: 'Fecha contable (America/Lima), límite inferior inclusivo.',
  })
  @IsNotEmpty()
  @IsDateOnly()
  accountingDateFrom!: string;

  @ApiProperty({
    type: String,
    example: '2026-03-31',
    description: 'Fecha contable (America/Lima), límite superior inclusivo.',
  })
  @IsNotEmpty()
  @IsDateOnly()
  accountingDateTo!: string;

  @ApiPropertyOptional({
    type: String,
    example:
      'c73ba68b-b76d-4b63-84a7-a4ab64476c5a,f2425704-0470-4c99-a9d4-bd0b029abae3',
    description:
      'Lista de ids de cuenta separados por coma. Si se omite, incluye todas las cuentas (único caso en que aplica la reconciliación de totales).',
  })
  @IsOptional()
  @Transform(commaSeparatedToArray)
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  accountIds?: string[];

  @ApiPropertyOptional({
    default: false,
    description:
      'Incluir cuentas sin saldo ni movimiento relevante en el rango.',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeZeroBalances?: boolean;
}
