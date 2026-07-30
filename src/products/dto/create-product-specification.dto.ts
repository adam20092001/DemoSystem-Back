import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateProductSpecificationDto {
  @ApiProperty({ maxLength: 80, example: 'Potencia' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ maxLength: 300, example: '750 W' })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  value!: string;

  @ApiPropertyOptional({ maxLength: 20, example: 'W' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
