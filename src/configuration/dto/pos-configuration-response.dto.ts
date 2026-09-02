import { ApiProperty } from '@nestjs/swagger';

/**
 * Configuración comercial de solo lectura para POS (Ticket A post-MVP).
 * Deliberadamente MÁS PEQUEÑO que ConfigurationResponseDto: expone
 * exactamente los 9 campos que el punto de venta necesita para operar
 * (identidad básica, moneda, IGV, descuento máximo permitido), nunca el
 * registro administrativo completo de CompanySettings. No reutiliza
 * ConfigurationResponseDto a propósito — acoplar el contrato de SELLER a la
 * evolución futura del DTO administrativo (p. ej. un campo nuevo pensado
 * solo para ADMIN/MANAGEMENT) filtraría ese campo a SELLER sin que nadie lo
 * decida explícitamente.
 */
export class PosConfigurationResponseDto {
  @ApiProperty()
  businessName!: string;

  @ApiProperty({ nullable: true, type: String })
  tradeName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  taxId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  address!: string | null;

  @ApiProperty({ example: 'PEN' })
  currencyCode!: string;

  @ApiProperty({ example: 'S/' })
  currencySymbol!: string;

  @ApiProperty({
    description:
      'Activa/desactiva el cálculo de IGV en el punto de venta. Mismo valor vigente que expone GET /configuration; nunca facturación electrónica/SUNAT/PLE.',
  })
  taxEnabled!: boolean;

  @ApiProperty({
    example: '18.00',
    description: 'Tasa de IGV aplicada cuando taxEnabled es true.',
  })
  taxRate!: string;

  @ApiProperty({
    example: '100.00',
    description:
      'Descuento máximo permitido (porcentaje) que el POS debe respetar al cotizar/vender.',
  })
  maxDiscountPercent!: string;
}
