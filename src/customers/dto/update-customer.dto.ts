import { ApiPropertyOptional } from '@nestjs/swagger';
import { CustomerDocumentType } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * code, customerType, customerStage, status e isGeneric nunca se aceptan
 * aquí: son inmutables desde update() (code/customerType/isGeneric para
 * siempre; customerStage y status cambian solo por sus endpoints dedicados
 * de ciclo de vida). documentType/documentNumber admiten null explícito
 * para limpiar el par; CustomersService exige que ambos lleguen presentes
 * juntos (o ninguno) y aplica la normalización (trim/upper).
 */
export class UpdateCustomerDto {
  @ApiPropertyOptional({ enum: CustomerDocumentType, nullable: true })
  @IsOptional()
  @IsEnum(CustomerDocumentType)
  documentType?: CustomerDocumentType | null;

  @ApiPropertyOptional({ maxLength: 32, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  documentNumber?: string | null;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({ maxLength: 150, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  tradeName?: string | null;

  @ApiPropertyOptional({ maxLength: 120, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactName?: string | null;

  @ApiPropertyOptional({ maxLength: 150, nullable: true })
  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  email?: string | null;

  @ApiPropertyOptional({ maxLength: 30, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional({ maxLength: 300, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string | null;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNotes?: string | null;
}
