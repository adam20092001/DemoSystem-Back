import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  DATA_QUALITY_FLAGS,
  RECONCILIATION_CLASSIFICATIONS,
  SIRE_REGISTERS,
  SIRE_SOURCES,
} from '../core/types';
import type {
  DataQualityFlag,
  ReconciliationClassification,
  SireRegister,
  SireSource,
} from '../core/types';
import { SIRE_DEMO_MAX_PAGE_SIZE } from '../sire-demo.constants';
import {
  SireCounterpartyDto,
  SireDocumentKeyDto,
  SireEnvelopeDto,
  SireExcludedDto,
} from './sire-demo-response.dto';

export class SireReconciliationExportQueryDto {
  @ApiPropertyOptional({
    enum: RECONCILIATION_CLASSIFICATIONS,
    description:
      'Filtra los ítems por clasificación. No altera el resumen, que siempre cubre el conjunto completo.',
  })
  @IsOptional()
  @IsIn(RECONCILIATION_CLASSIFICATIONS, {
    message: 'classification no es una clasificación válida',
  })
  classification?: ReconciliationClassification;
}

export class SireReconciliationQueryDto extends SireReconciliationExportQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: SIRE_DEMO_MAX_PAGE_SIZE,
    default: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SIRE_DEMO_MAX_PAGE_SIZE)
  pageSize?: number;
}

export class SireReconciliationProposalDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: SIRE_SOURCES })
  source!: SireSource;

  @ApiProperty({ enum: SIRE_REGISTERS })
  register!: SireRegister;

  @ApiProperty({ example: '202601' })
  period!: string;

  @ApiProperty({ type: String, nullable: true, example: 'demo-fixtures-v1' })
  fixtureSetVersion!: string | null;

  @ApiProperty()
  fileName!: string;

  @ApiProperty({ description: 'SHA-256 (hex) del archivo cargado.' })
  fileHash!: string;

  @ApiProperty()
  rowCount!: number;
}

export class SireReconciliationDifferenceDto {
  @ApiProperty({ example: 'total' })
  field!: string;

  @ApiProperty({ type: String, nullable: true, example: '1000.00' })
  pos!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '1100.00' })
  proposal!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '100.00',
    description: 'proposal - pos; solo para campos monetarios.',
  })
  delta!: string | null;
}

export class SireReconciliationPosSideDto {
  @ApiProperty()
  refId!: string;

  @ApiProperty({ example: '2026-01-05' })
  issueDate!: string;

  @ApiProperty({ example: 'PEN' })
  currencyCode!: string;

  @ApiProperty({ type: SireCounterpartyDto })
  counterparty!: SireCounterpartyDto;

  @ApiProperty({ type: String, nullable: true, example: '847.46' })
  taxableBase!: string | null;

  @ApiProperty({ example: '152.54' })
  igv!: string;

  @ApiProperty({ example: '1000.00' })
  total!: string;

  @ApiProperty({ enum: DATA_QUALITY_FLAGS, isArray: true })
  flags!: DataQualityFlag[];

  @ApiProperty({
    description:
      'Estado INTERNO del POS. Nunca significa aceptación ante SUNAT.',
  })
  internalStatus!: string;
}

export class SireReconciliationProposalSideDto {
  @ApiProperty({
    type: [Number],
    description: 'Líneas del archivo donde aparece la clave.',
  })
  lineNumbers!: number[];

  @ApiProperty({ description: '>= 2 implica DUPLICATE_IN_PROPOSAL.' })
  occurrences!: number;

  @ApiProperty({ example: '2026-01-05' })
  issueDate!: string;

  @ApiProperty({ type: SireCounterpartyDto })
  counterparty!: SireCounterpartyDto;

  @ApiProperty({ example: '847.46', description: 'Primera aparición.' })
  taxableBase!: string;

  @ApiProperty({ example: '152.54' })
  igv!: string;

  @ApiProperty({ example: '1000.00' })
  total!: string;

  @ApiProperty({
    example: '0.00',
    description: 'Suma de las apariciones adicionales (no entra en totales).',
  })
  duplicateSurplusTotal!: string;
}

export class SireReconciliationItemDto {
  @ApiProperty({ enum: RECONCILIATION_CLASSIFICATIONS })
  classification!: ReconciliationClassification;

  @ApiProperty({ type: SireDocumentKeyDto, nullable: true })
  key!: SireDocumentKeyDto | null;

  @ApiProperty({ type: [SireReconciliationDifferenceDto] })
  differences!: SireReconciliationDifferenceDto[];

  @ApiProperty({ type: SireReconciliationPosSideDto, nullable: true })
  pos!: SireReconciliationPosSideDto | null;

  @ApiProperty({ type: SireReconciliationProposalSideDto, nullable: true })
  proposal!: SireReconciliationProposalSideDto | null;
}

export class SireClassificationTotalsDto {
  @ApiProperty()
  count!: number;

  @ApiProperty({ example: '1000.00' })
  posTotal!: string;

  @ApiProperty({ example: '1000.00' })
  proposalTotal!: string;
}

export class SireForeignCurrencyDto {
  @ApiProperty({ example: 'USD' })
  currencyCode!: string;

  @ApiProperty()
  documents!: number;
}

export class SireReconciliationTotalsDto {
  @ApiProperty({ example: '14000.00' })
  pos!: string;

  @ApiProperty({ example: '13600.00', description: 'Cada clave suma una vez.' })
  proposalDistinct!: string;

  @ApiProperty({ example: '1000.00' })
  duplicateSurplus!: string;

  @ApiProperty({ example: '14600.00' })
  proposalRaw!: string;

  @ApiProperty({ example: '-400.00', description: 'proposalDistinct - pos.' })
  delta!: string;
}

export class SireReconciliationSummaryDto {
  @ApiProperty({
    example: 'PEN',
    description: 'Única moneda sumada; no existe conversión.',
  })
  currencyCode!: string;

  @ApiProperty({ type: [SireForeignCurrencyDto] })
  foreignCurrencyDocuments!: SireForeignCurrencyDto[];

  @ApiProperty({ description: 'Total de ítems del conjunto completo.' })
  total!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: getSchemaPath(SireClassificationTotalsDto) },
    description: 'Una entrada por cada clasificación.',
  })
  byClassification!: Record<
    ReconciliationClassification,
    SireClassificationTotalsDto
  >;

  @ApiProperty({ type: SireReconciliationTotalsDto })
  totals!: SireReconciliationTotalsDto;
}

export class SireReconciliationCountsDto {
  @ApiProperty()
  posDocuments!: number;

  @ApiProperty()
  proposalRows!: number;

  @ApiProperty()
  items!: number;
}

export class SireReconciliationResponseDto extends SireEnvelopeDto {
  @ApiProperty({ enum: SIRE_SOURCES })
  source!: SireSource;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'demo-fixtures-v1',
    description: 'Versión guardada en la propuesta; null para POS.',
  })
  fixtureSetVersion!: string | null;

  @ApiProperty({ enum: SIRE_REGISTERS })
  register!: SireRegister;

  @ApiProperty({ example: '202601' })
  period!: string;

  @ApiProperty({ type: SireReconciliationProposalDto })
  proposal!: SireReconciliationProposalDto;

  @ApiProperty({
    description:
      'Regla PROVISIONAL del periodo (RVIE: issueDate en America/Lima; RCE: accountingDate).',
  })
  periodRule!: string;

  @ApiProperty({
    description:
      'Aviso: los documentos del origen no tienen validez fiscal (comprobantes MOCK / datos sintéticos).',
  })
  sourceNote!: string;

  @ApiProperty({ type: SireExcludedDto })
  excluded!: SireExcludedDto;

  @ApiProperty({ type: SireReconciliationCountsDto })
  counts!: SireReconciliationCountsDto;

  @ApiProperty({
    type: SireReconciliationSummaryDto,
    description: 'Siempre del conjunto completo, sin filtro ni página.',
  })
  summary!: SireReconciliationSummaryDto;

  @ApiProperty({
    description:
      'SHA-256 determinista del listado canónico; coincide con el del Excel.',
  })
  resultDigest!: string;

  @ApiProperty({
    enum: RECONCILIATION_CLASSIFICATIONS,
    nullable: true,
    type: String,
    description: 'Filtro aplicado a `items`, si lo hubo.',
  })
  classification!: ReconciliationClassification | null;

  @ApiProperty({ type: [SireReconciliationItemDto] })
  items!: SireReconciliationItemDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty({
    description: 'Ítems que cumplen el filtro (antes de paginar).',
  })
  totalItems!: number;
}
