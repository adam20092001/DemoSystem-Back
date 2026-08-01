import { ApiProperty } from '@nestjs/swagger';

export class ProductSpecificationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  value!: string;

  @ApiProperty({ nullable: true, type: String })
  unit!: string | null;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
