import { ApiProperty } from '@nestjs/swagger';

export class CountryResponseDto {
  @ApiProperty({ example: 'CN' })
  code!: string;

  @ApiProperty({ example: 'China' })
  name!: string;

  @ApiProperty({
    description:
      'false: no se ofrece en formularios nuevos; los documentos históricos lo conservan.',
  })
  active!: boolean;

  @ApiProperty({
    description:
      'true: código incorporado desde datos históricos cuya identidad no se verificó (nombre provisional).',
  })
  pendingReview!: boolean;

  @ApiProperty({ type: String, nullable: true })
  createdByUserId!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
