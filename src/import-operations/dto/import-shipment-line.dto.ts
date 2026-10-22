import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/** Decimal como texto, positivo, máximo 3 decimales (Decimal(14,3)), mismo criterio que PurchaseInvoiceLine. */
export const IMPORT_SHIPMENT_QUANTITY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;

/**
 * Una línea sin productId exige `descriptionSnapshot`; con productId, es
 * opcional (el servicio la copia de Product.name por defecto). Las
 * mediciones de peso/volumen y el vínculo a factura son siempre opcionales
 * (CLAUDE.md B1 §2/§3).
 */
export class ImportShipmentLineDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({
    maxLength: 300,
    description:
      'Obligatoria si no se provee productId; si se provee, el servicio la copia de Product.name por defecto cuando se omite aquí.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  descriptionSnapshot?: string;

  @ApiPropertyOptional({ type: String, example: '100.000' })
  @IsString()
  @Matches(IMPORT_SHIPMENT_QUANTITY_PATTERN, {
    message:
      'plannedQuantity debe ser un decimal positivo, como texto, con máximo 3 decimales',
  })
  plannedQuantity!: string;

  @ApiPropertyOptional({ maxLength: 15 })
  @IsOptional()
  @IsString()
  @MaxLength(15)
  unitCode?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  unitName?: string;

  @ApiPropertyOptional({ type: String, example: '1200.500' })
  @IsOptional()
  @IsString()
  @Matches(IMPORT_SHIPMENT_QUANTITY_PATTERN, {
    message:
      'weightValue debe ser un decimal no negativo, como texto, con máximo 3 decimales',
  })
  weightValue?: string;

  @ApiPropertyOptional({ maxLength: 10, example: 'kg' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  weightUnit?: string;

  @ApiPropertyOptional({ type: String, example: '3.500' })
  @IsOptional()
  @IsString()
  @Matches(IMPORT_SHIPMENT_QUANTITY_PATTERN, {
    message:
      'volumeValue debe ser un decimal no negativo, como texto, con máximo 3 decimales',
  })
  volumeValue?: string;

  @ApiPropertyOptional({ maxLength: 10, example: 'm3' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  volumeUnit?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Vínculo OPCIONAL a una línea de factura de compra CONFIRMED existente. Nunca excede, junto con otros embarques, la cantidad facturada.',
  })
  @IsOptional()
  @IsUUID()
  purchaseInvoiceLineId?: string;
}
