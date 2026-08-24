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
      'Bloque C: expuesto en modo lectura con su valor semilla; aún no editable por PATCH en el Bloque A.',
  })
  taxEnabled!: boolean;

  @ApiProperty({
    example: '18.00',
    description:
      'Bloque C: expuesto en modo lectura con su valor semilla; aún no editable por PATCH en el Bloque A.',
  })
  taxRate!: string;

  @ApiProperty({
    example: 15,
    description:
      'Bloque B: expuesto en modo lectura con su valor semilla; aún no editable por PATCH en el Bloque A.',
  })
  quoteValidityDays!: number;

  @ApiProperty({
    example: '100.00',
    description:
      'Bloque B: expuesto en modo lectura con su valor semilla; aún no editable por PATCH en el Bloque A.',
  })
  maxDiscountPercent!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
