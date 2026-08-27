import { ApiProperty } from '@nestjs/swagger';
import { FiscalDocumentType } from '@prisma/client';

export class FiscalSeriesResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: FiscalDocumentType })
  documentType!: FiscalDocumentType;

  @ApiProperty({ example: 'F001' })
  series!: string;

  @ApiProperty({
    example: 5,
    description:
      'Último número YA emitido (0 = ninguno todavía). Puramente informativo: nunca representa un "próximo número" reservable, ya que la emisión concurrente puede dejarlo obsoleto de inmediato.',
  })
  currentNumber!: number;

  @ApiProperty()
  active!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
