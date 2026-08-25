import { ApiProperty } from '@nestjs/swagger';

export class ConfigurationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  businessName!: string;

  @ApiProperty({ nullable: true, type: String })
  tradeName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  taxId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  address!: string | null;

  @ApiProperty({ nullable: true, type: String })
  phone!: string | null;

  @ApiProperty({ nullable: true, type: String })
  email!: string | null;

  @ApiProperty({ example: 'PEN' })
  currencyCode!: string;

  @ApiProperty({ example: 'S/' })
  currencySymbol!: string;

  @ApiProperty({
    description:
      'Activa/desactiva el cálculo de IGV a nivel de documento para cotizaciones y ventas DIRECTAS nuevas o comercialmente modificadas. Editable por PATCH desde el Bloque C. IGV interno del sistema, no facturación electrónica/SUNAT/PLE.',
  })
  taxEnabled!: boolean;

  @ApiProperty({
    example: '18.00',
    description:
      'Tasa de IGV aplicada cuando taxEnabled es true. Editable por PATCH desde el Bloque C; el par resultante debe cumplir taxEnabled=false o taxRate > 0. Cambiarla nunca recalcula cotizaciones/ventas ya existentes.',
  })
  taxRate!: string;

  @ApiProperty({
    example: 15,
    description:
      'Vigencia por defecto (días calendario) de una cotización nueva sin expirationDate explícito. Editable por PATCH desde el Bloque B; cambiarlo nunca modifica cotizaciones ya existentes.',
  })
  quoteValidityDays!: number;

  @ApiProperty({
    example: '100.00',
    description:
      'Descuento máximo permitido (porcentaje) para cotizaciones/ventas nuevas o comercialmente modificadas. Editable por PATCH desde el Bloque B; cambiarlo nunca revalida ni recalcula documentos ya existentes.',
  })
  maxDiscountPercent!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
