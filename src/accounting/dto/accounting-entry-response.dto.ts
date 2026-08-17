import { ApiProperty } from '@nestjs/swagger';
import { AccountingEventType, AccountingSourceType } from '@prisma/client';

/**
 * Fila compacta del listado (libro diario). Sin sourceNumber (requeriría
 * una consulta polimórfica adicional a Sale/Payment, fuera del plan
 * cerrado), sin lines ni createdBy: el listado debe permanecer compacto.
 */
export class AccountingEntryListItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: AccountingSourceType })
  sourceType!: AccountingSourceType;

  @ApiProperty({ format: 'uuid' })
  sourceId!: string;

  @ApiProperty({ enum: AccountingEventType })
  eventType!: AccountingEventType;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  reversesEntryId!: string | null;

  @ApiProperty()
  description!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  postedAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/** Respuesta paginada de asientos contables, orden cronológico. */
export class PaginatedAccountingEntriesResponseDto {
  @ApiProperty({ type: [AccountingEntryListItemResponseDto] })
  data!: AccountingEntryListItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

/** Identidad mínima segura del usuario que registró el asiento. */
export class AccountingUserResponseDto {
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
 * Línea segura con el código/nombre de cuenta ya resueltos (join a
 * chart_of_accounts, nunca snapshot duplicado: las cuentas son inmutables
 * en este MVP). Montos siempre string de 2 decimales fijos.
 */
export class AccountingEntryLineResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ example: 'AR' })
  accountCode!: string;

  @ApiProperty({ example: 'Cuentas por cobrar' })
  accountName!: string;

  @ApiProperty({ type: String })
  debitAmount!: string;

  @ApiProperty({ type: String })
  creditAmount!: string;
}

/** Detalle completo de un asiento contable, con su actor y sus líneas. */
export class AccountingEntryResponseDto extends AccountingEntryListItemResponseDto {
  @ApiProperty({ type: AccountingUserResponseDto })
  createdBy!: AccountingUserResponseDto;

  @ApiProperty({ type: [AccountingEntryLineResponseDto] })
  lines!: AccountingEntryLineResponseDto[];
}
