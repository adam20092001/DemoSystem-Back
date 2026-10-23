import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ImportExpenseAllocationMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IMPORT_EXPENSE_MONEY_PATTERN } from './create-import-expense.dto';

export class ManualAllocationLineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  importShipmentLineId!: string;

  @ApiProperty({ type: String, example: '100.00' })
  @IsString()
  @Matches(IMPORT_EXPENSE_MONEY_PATTERN, {
    message:
      'amount debe ser un decimal positivo, como texto, con máximo 2 decimales',
  })
  amount!: string;
}

/**
 * `amountToAllocate` es SIEMPRE explícito: nunca se asume el monto total
 * del gasto por defecto (CLAUDE.md B2 §3). Exactamente uno de
 * `shipmentLineIds` (QUANTITY/WEIGHT/VOLUME) o `manualAllocations`
 * (MANUAL) debe proveerse, según `method` — validado por el servicio.
 */
export class AllocateImportExpenseDto {
  @ApiProperty({ enum: ImportExpenseAllocationMethod })
  @IsEnum(ImportExpenseAllocationMethod)
  method!: ImportExpenseAllocationMethod;

  @ApiProperty({
    type: String,
    example: '1250.00',
    description:
      'Monto EXPLÍCITO a repartir en este lote — puede ser menor al monto total del gasto (asignación parcial/incremental).',
  })
  @IsString()
  @Matches(IMPORT_EXPENSE_MONEY_PATTERN, {
    message:
      'amountToAllocate debe ser un decimal positivo, como texto, con máximo 2 decimales',
  })
  amountToAllocate!: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Obligatorio para method=QUANTITY/WEIGHT/VOLUME.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  shipmentLineIds?: string[];

  @ApiPropertyOptional({
    type: [ManualAllocationLineDto],
    description: 'Obligatorio para method=MANUAL.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ManualAllocationLineDto)
  manualAllocations?: ManualAllocationLineDto[];

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Opcional: reenviarla en un reintento devuelve el mismo lote ya creado.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;
}
