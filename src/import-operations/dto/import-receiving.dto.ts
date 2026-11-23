import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IMPORT_RECEIPT_LINK_QUANTITY_PATTERN } from './create-import-receipt-link.dto';
import { IsDateOnly } from './is-date-only.decorator';

/** Máximo de líneas por solicitud (mismo orden de magnitud que las recepciones de compra). */
export const MAX_IMPORT_RECEIVING_LINES = 100;

export class ReceiveFromImportLineDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Línea del embarque (ImportShipmentLine) que se recibe.',
  })
  @IsUUID()
  importShipmentLineId!: string;

  @ApiProperty({
    type: String,
    example: '30.000',
    description:
      'Cantidad realmente recibida: decimal positivo, como texto, máximo 3 decimales. No puede superar el pendiente de la línea de embarque ni lo disponible de la factura.',
  })
  @IsString()
  @Matches(IMPORT_RECEIPT_LINK_QUANTITY_PATTERN, {
    message:
      'quantity debe ser un decimal positivo, como texto, con máximo 3 decimales',
  })
  quantity!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Ubicación de destino (almacén y ubicación activos). Si se omite, MAIN/DEFAULT.',
  })
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class ReceiveFromImportDto {
  @ApiPropertyOptional({
    example: '2026-11-23',
    description: 'Fecha de recepción YYYY-MM-DD (por defecto, hoy en Lima).',
  })
  @IsOptional()
  @IsDateOnly()
  receivedDate?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiProperty({ type: [ReceiveFromImportLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IMPORT_RECEIVING_LINES)
  @ValidateNested({ each: true })
  @Type(() => ReceiveFromImportLineDto)
  lines!: ReceiveFromImportLineDto[];

  @ApiPropertyOptional({
    default: false,
    description:
      '"Recibir mercadería y completar": tras recibir, completa la operación en la MISMA transacción. Si no se cumplen todas las condiciones de cierre, no se hace nada (409).',
  })
  @IsOptional()
  @IsBoolean()
  completeOperation?: boolean;
}

export class LinkExistingReceiptLineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  importShipmentLineId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Línea de una recepción de compra ACTIVE ya registrada.',
  })
  @IsUUID()
  purchaseReceiptLineId!: string;

  @ApiProperty({ type: String, example: '10.000' })
  @IsString()
  @Matches(IMPORT_RECEIPT_LINK_QUANTITY_PATTERN, {
    message:
      'linkedQuantity debe ser un decimal positivo, como texto, con máximo 3 decimales',
  })
  linkedQuantity!: string;
}

export class LinkExistingReceiptsDto {
  @ApiProperty({ type: [LinkExistingReceiptLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IMPORT_RECEIVING_LINES)
  @ValidateNested({ each: true })
  @Type(() => LinkExistingReceiptLineDto)
  links!: LinkExistingReceiptLineDto[];

  @ApiPropertyOptional({
    default: false,
    description:
      'Vincula y completa en la misma transacción (todo o nada), con las mismas condiciones de cierre.',
  })
  @IsOptional()
  @IsBoolean()
  completeOperation?: boolean;
}
