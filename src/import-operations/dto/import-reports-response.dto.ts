import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ImportExpenseCategory,
  ImportExpenseStatus,
  ImportOperationStatus,
  ImportShipmentStatus,
  PurchaseReceiptStatus,
} from '@prisma/client';

export class CargoUnitAggregateDto {
  @ApiPropertyOptional({ nullable: true, example: 'kg' })
  unitCode!: string | null;

  @ApiProperty() plannedQuantity!: string;
  @ApiProperty() linkedReceivedQuantity!: string;
  @ApiProperty() unlinkedQuantity!: string;
}

export class RelatedPurchaseInvoiceRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() documentType!: string;
  @ApiPropertyOptional({ nullable: true }) documentSeries!: string | null;
  @ApiProperty() documentNumber!: string;
}

export class ExpenseCurrencyAggregateDto {
  @ApiProperty({ example: 'USD' }) currencyCode!: string;
  @ApiProperty() expenseCount!: number;
  @ApiProperty() cancelledCount!: number;
  @ApiProperty() totalAmount!: string;
  @ApiProperty() allocatedAmount!: string;
  @ApiProperty() unallocatedAmount!: string;
  @ApiProperty() attributedAmount!: string;
  @ApiProperty() unattributedAmount!: string;
  @ApiProperty({ enum: ['PENDING_FX', 'PENDING_ACCOUNTING_POLICY'] })
  financialStatus!: string;
}

export class ImportOperationSummaryRowDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ enum: ImportOperationStatus }) status!: ImportOperationStatus;
  @ApiProperty() originCountry!: string;
  @ApiProperty() destinationCountry!: string;
  @ApiProperty() createdAt!: Date;
  @ApiPropertyOptional({ nullable: true }) completedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) cancelledAt!: Date | null;
  @ApiProperty({ type: Object }) shipmentCountsByStatus!: Record<
    ImportShipmentStatus,
    number
  >;
  @ApiProperty({ type: [CargoUnitAggregateDto] })
  cargoByUnit!: CargoUnitAggregateDto[];
  @ApiProperty({ type: [RelatedPurchaseInvoiceRefDto] })
  relatedPurchaseInvoices!: RelatedPurchaseInvoiceRefDto[];
  @ApiProperty({ type: [ExpenseCurrencyAggregateDto] })
  expensesByCurrency!: ExpenseCurrencyAggregateDto[];
}

export class ImportOperationSummaryResponseDto {
  @ApiProperty({ type: [ImportOperationSummaryRowDto] })
  data!: ImportOperationSummaryRowDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class ShipmentReconciliationLinkRefDto {
  @ApiProperty({ format: 'uuid' }) importReceiptLinkId!: string;
  @ApiProperty({ format: 'uuid' }) purchaseReceiptLineId!: string;
  @ApiProperty({ format: 'uuid' }) purchaseReceiptId!: string;
  @ApiProperty({ enum: PurchaseReceiptStatus })
  receiptStatus!: PurchaseReceiptStatus;
  @ApiProperty({ enum: ['ACTIVE', 'CANCELLED'] }) linkStatus!: string;
  @ApiProperty() linkedQuantity!: string;
}

export class ShipmentReconciliationRowDto {
  @ApiProperty({ format: 'uuid' }) importShipmentLineId!: string;
  @ApiProperty({ format: 'uuid' }) importShipmentId!: string;
  @ApiProperty({ format: 'uuid' }) importOperationId!: string;
  @ApiProperty({ enum: ImportShipmentStatus })
  shipmentStatus!: ImportShipmentStatus;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) productId!:
    string | null;
  @ApiProperty() descriptionSnapshot!: string;
  @ApiPropertyOptional({ nullable: true }) unitCode!: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  purchaseInvoiceLineId!: string | null;
  @ApiProperty() plannedQuantity!: string;
  @ApiProperty() linkedQuantity!: string;
  @ApiProperty() remainingQuantity!: string;
  @ApiProperty({ type: [ShipmentReconciliationLinkRefDto] })
  links!: ShipmentReconciliationLinkRefDto[];
  @ApiProperty({ type: [String] }) discrepancyCodes!: string[];
}

export class ShipmentReconciliationResponseDto {
  @ApiProperty({ type: [ShipmentReconciliationRowDto] })
  data!: ShipmentReconciliationRowDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class ExpenseReconciliationRowDto {
  @ApiProperty({ format: 'uuid' }) importExpenseId!: string;
  @ApiProperty({ format: 'uuid' }) importOperationId!: string;
  @ApiProperty({ enum: ImportExpenseCategory })
  category!: ImportExpenseCategory;
  @ApiPropertyOptional({ nullable: true }) documentReference!: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) supplierId!:
    string | null;
  @ApiProperty({ example: 'USD' }) currencyCode!: string;
  @ApiProperty() amount!: string;
  @ApiProperty({ enum: ImportExpenseStatus }) status!: ImportExpenseStatus;
  @ApiProperty() allocatedAmount!: string;
  @ApiProperty() unallocatedAmount!: string;
  @ApiProperty() attributedAmount!: string;
  @ApiProperty() unattributedAmount!: string;
  @ApiPropertyOptional({
    nullable: true,
    enum: ['PENDING_FX', 'PENDING_ACCOUNTING_POLICY'],
  })
  financialStatus!: string | null;
}

export class ExpenseReconciliationResponseDto {
  @ApiProperty({ type: [ExpenseReconciliationRowDto] })
  data!: ExpenseReconciliationRowDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class ConsolidatedReconciliationRowDto {
  @ApiProperty({ format: 'uuid' }) importOperationId!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ enum: ImportOperationStatus })
  operationStatus!: ImportOperationStatus;
  @ApiProperty({
    enum: [
      'CONSISTENT',
      'PARTIAL_PENDING_OPERATIONAL_LINK',
      'PENDING_ACCOUNTING_POLICY',
      'PENDING_FX',
      'DATA_INCONSISTENCY',
    ],
  })
  reconciliationStatus!: string;
  @ApiProperty({ type: [String] }) reasons!: string[];
  @ApiProperty({ type: [CargoUnitAggregateDto] })
  cargoByUnit!: CargoUnitAggregateDto[];
  @ApiProperty({ type: [ExpenseCurrencyAggregateDto] })
  expensesByCurrency!: ExpenseCurrencyAggregateDto[];
  @ApiProperty({ type: [String] }) discrepancyCodes!: string[];
}

export class ConsolidatedReconciliationResponseDto {
  @ApiProperty({ type: [ConsolidatedReconciliationRowDto] })
  data!: ConsolidatedReconciliationRowDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
