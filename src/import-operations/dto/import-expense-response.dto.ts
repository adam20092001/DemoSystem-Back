import { ApiProperty } from '@nestjs/swagger';
import {
  ImportExpenseCategory,
  ImportExpenseDocumentType,
  ImportExpenseStatus,
} from '@prisma/client';

class ImportExpenseActorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

/**
 * Documenta exactamente los campos de SafeImportExpense. Es
 * documentación de contrato/Swagger, no una segunda fuente de mapeo.
 */
export class ImportExpenseResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  importOperationId!: string;

  @ApiProperty({ enum: ImportExpenseCategory })
  category!: ImportExpenseCategory;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ nullable: true, type: String })
  supplierId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  purchaseInvoiceLineId!: string | null;

  @ApiProperty({ enum: ImportExpenseDocumentType, nullable: true })
  documentType!: ImportExpenseDocumentType | null;

  @ApiProperty({ nullable: true, type: String })
  documentReference!: string | null;

  @ApiProperty({ example: '2026-11-05' })
  expenseDate!: string;

  @ApiProperty({ example: 'USD' })
  currencyCode!: string;

  @ApiProperty()
  amount!: string;

  @ApiProperty({ nullable: true, type: String })
  remarks!: string | null;

  @ApiProperty({ enum: ImportExpenseStatus })
  status!: ImportExpenseStatus;

  @ApiProperty({ type: ImportExpenseActorDto })
  createdBy!: ImportExpenseActorDto;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiProperty({ nullable: true, type: Date })
  finalizedAt!: Date | null;

  @ApiProperty({ nullable: true, type: ImportExpenseActorDto })
  finalizedBy!: ImportExpenseActorDto | null;

  @ApiProperty({ nullable: true, type: Date })
  cancelledAt!: Date | null;

  @ApiProperty({ nullable: true, type: ImportExpenseActorDto })
  cancelledBy!: ImportExpenseActorDto | null;

  @ApiProperty({ nullable: true, type: String })
  cancellationReason!: string | null;

  @ApiProperty({
    description: 'Suma de asignaciones ya registradas, en currencyCode.',
  })
  allocatedAmount!: string;

  @ApiProperty({ description: 'amount - allocatedAmount.' })
  unallocatedAmount!: string;
}

export class PaginatedImportExpensesResponseDto {
  @ApiProperty({ type: [ImportExpenseResponseDto] })
  data!: ImportExpenseResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
