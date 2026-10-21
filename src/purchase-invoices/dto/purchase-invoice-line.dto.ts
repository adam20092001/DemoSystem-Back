import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PurchaseAcquisitionKind,
  PurchaseLineTaxBasis,
  PurchaseLineTaxCategory,
  PurchasePurpose,
} from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Decimal como texto, positivo, máximo 3 decimales (Decimal(14,3), mismo criterio que InventoryMovement/SaleItem.quantity). */
export const PURCHASE_QUANTITY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;
/** Decimal como texto, no negativo, máximo 2 decimales (Decimal(14,2)). */
export const PURCHASE_MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Una línea sin productId exige `description`; con productId, es opcional
 * (el servicio la copia de Product.name por defecto). taxBasis solo se
 * valida como obligatorio en el servicio cuando taxCategory=TAXED (no se
 * expresa aquí con class-validator condicional para no duplicar la regla
 * de dominio en dos capas). creditableTaxAmount NUNCA se infiere de
 * taxCategory — default '0' si se omite.
 */
export class CreatePurchaseInvoiceLineDto {
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
  @MinLength(1)
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({
    maxLength: 60,
    description:
      'Rótulo de unidad en texto libre, solo relevante sin productId (con productId, el servicio copia la unidad real del producto).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  unitLabel?: string;

  @ApiProperty({ enum: PurchaseAcquisitionKind })
  @IsEnum(PurchaseAcquisitionKind)
  acquisitionKind!: PurchaseAcquisitionKind;

  @ApiProperty({ enum: PurchasePurpose })
  @IsEnum(PurchasePurpose)
  purchasePurpose!: PurchasePurpose;

  @ApiProperty({ type: String, example: '10.000' })
  @IsString()
  @Matches(PURCHASE_QUANTITY_PATTERN, {
    message:
      'quantity debe ser un decimal positivo, como texto, con máximo 3 decimales',
  })
  quantity!: string;

  @ApiProperty({ type: String, example: '25.50' })
  @IsString()
  @Matches(PURCHASE_MONEY_PATTERN, {
    message:
      'unitCost debe ser un decimal no negativo, como texto, con máximo 2 decimales',
  })
  unitCost!: string;

  @ApiProperty({ enum: PurchaseLineTaxCategory })
  @IsEnum(PurchaseLineTaxCategory)
  taxCategory!: PurchaseLineTaxCategory;

  @ApiPropertyOptional({
    enum: PurchaseLineTaxBasis,
    description:
      'Obligatorio cuando taxCategory=TAXED; ignorado en cualquier otro caso.',
  })
  @IsOptional()
  @IsEnum(PurchaseLineTaxBasis)
  taxBasis?: PurchaseLineTaxBasis;

  @ApiPropertyOptional({
    type: String,
    example: '0.00',
    default: '0.00',
    description:
      'Nunca inferido de taxCategory: cuánto del impuesto de esta línea se reconoce como crédito fiscal. Default "0.00" si se omite (nunca asumir deducibilidad). No puede superar el impuesto calculado de la línea.',
  })
  @IsOptional()
  @IsString()
  @Matches(PURCHASE_MONEY_PATTERN, {
    message:
      'creditableTaxAmount debe ser un decimal no negativo, como texto, con máximo 2 decimales',
  })
  creditableTaxAmount?: string;
}
