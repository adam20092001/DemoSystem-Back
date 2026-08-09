import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  CustomerDocumentType,
  CustomerStage,
  CustomerStatus,
  CustomerType,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { toStrictBoolean } from '../../common/validators/to-strict-boolean.transform';

/** Sin orderBy/sort/direction: el orden es fijo (createdAt desc, id desc) en el servicio. */
export class ListCustomersQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    enum: CustomerStatus,
    description:
      'SELLER solo puede filtrar ACTIVE/BLOCKED; INACTIVE devuelve página vacía. WAREHOUSE no tiene acceso.',
  })
  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;

  @ApiPropertyOptional({ enum: CustomerType })
  @IsOptional()
  @IsEnum(CustomerType)
  customerType?: CustomerType;

  @ApiPropertyOptional({ enum: CustomerStage })
  @IsOptional()
  @IsEnum(CustomerStage)
  customerStage?: CustomerStage;

  @ApiPropertyOptional({ enum: CustomerDocumentType })
  @IsOptional()
  @IsEnum(CustomerDocumentType)
  documentType?: CustomerDocumentType;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Acepta true/false (boolean o string). Cualquier otro valor falla la validación.',
  })
  @IsOptional()
  @Transform(toStrictBoolean)
  @IsBoolean()
  isGeneric?: boolean;

  @ApiPropertyOptional({
    maxLength: 150,
    description:
      'Búsqueda por documentNumber, name, phone, tradeName, contactName o email (insensible a mayúsculas).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  search?: string;
}
