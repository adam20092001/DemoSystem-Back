import { ApiProperty } from '@nestjs/swagger';
import { UnitStatus } from '@prisma/client';

export class UnitResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  abbreviation!: string;

  @ApiProperty()
  allowDecimal!: boolean;

  @ApiProperty({ enum: UnitStatus })
  status!: UnitStatus;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class PaginatedUnitsResponseDto {
  @ApiProperty({ type: [UnitResponseDto] })
  data!: UnitResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
