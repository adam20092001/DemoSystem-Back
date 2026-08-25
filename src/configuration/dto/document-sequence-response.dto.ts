import { ApiProperty } from '@nestjs/swagger';
import { DocumentType } from '@prisma/client';

export class DocumentSequenceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: DocumentType, example: DocumentType.QUOTE })
  documentType!: DocumentType;

  @ApiProperty({ example: 'COT-' })
  prefix!: string;

  @ApiProperty({ example: 6, minimum: 1, maximum: 12 })
  padding!: number;

  @ApiProperty({
    example: 150,
    description:
      'Último número emitido (no el próximo). El próximo documento generado usará currentNumber + 1 formateado con el padding vigente.',
  })
  currentNumber!: number;

  @ApiProperty()
  updatedAt!: Date;
}
