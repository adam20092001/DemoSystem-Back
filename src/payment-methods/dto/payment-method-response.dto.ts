import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethodAccountingDestination } from '@prisma/client';

export class PaymentMethodResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'YAPE' })
  code!: string;

  @ApiProperty({ example: 'Yape' })
  name!: string;

  @ApiProperty({
    description:
      'false: no disponible para nuevos cobros; nunca implica borrado.',
  })
  active!: boolean;

  @ApiProperty()
  requiresReference!: boolean;

  @ApiProperty()
  affectsCashDrawer!: boolean;

  @ApiProperty({ enum: PaymentMethodAccountingDestination })
  accountingDestination!: PaymentMethodAccountingDestination;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
