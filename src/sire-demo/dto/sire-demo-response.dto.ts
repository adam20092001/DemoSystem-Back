import { ApiProperty } from '@nestjs/swagger';
import {
  DATA_QUALITY_FLAGS,
  SIRE_REGISTERS,
  SIRE_SOURCES,
} from '../core/types';
import type { DataQualityFlag, SireRegister, SireSource } from '../core/types';

/** Sobre común: toda respuesta JSON identifica el modo y la ausencia de validez oficial. */
export class SireEnvelopeDto {
  @ApiProperty({ example: 'DEMO' })
  mode!: 'DEMO';

  @ApiProperty({ example: false })
  officialValidity!: false;

  @ApiProperty({ example: 'DEMO_V1' })
  formatVersion!: 'DEMO_V1';
}

export class SireLimitsDto {
  @ApiProperty({ example: 2097152 })
  maxFileBytes!: number;

  @ApiProperty({ example: 5000 })
  maxRows!: number;
}

export class SirePeriodCountDto {
  @ApiProperty({ example: '202601' })
  period!: string;

  @ApiProperty({ example: 14 })
  documentCount!: number;
}

export class SireRegisterPeriodsDto {
  @ApiProperty({ type: [SirePeriodCountDto] })
  periods!: SirePeriodCountDto[];
}

export class SireSourceRegistersDto {
  @ApiProperty({ type: SireRegisterPeriodsDto })
  RVIE!: SireRegisterPeriodsDto;

  @ApiProperty({ type: SireRegisterPeriodsDto })
  RCE!: SireRegisterPeriodsDto;
}

export class SireSourceInfoDto {
  @ApiProperty({ enum: SIRE_SOURCES })
  source!: SireSource;

  @ApiProperty({
    description:
      'false si el origen está deshabilitado en este ambiente (p. ej. DEMO_FIXTURES sin SIRE_DEMO_FIXTURES_ENABLED).',
  })
  available!: boolean;

  @ApiProperty({ type: String, nullable: true, example: 'demo-fixtures-v1' })
  fixtureSetVersion!: string | null;

  @ApiProperty({ type: [String], example: ['demo-fixtures-v1'] })
  supportedFixtureVersions!: string[];

  @ApiProperty({
    description:
      'true si el origen no tiene ningún documento en ningún registro.',
  })
  isEmpty!: boolean;

  @ApiProperty({ type: SireSourceRegistersDto })
  registers!: SireSourceRegistersDto;
}

export class SireContextResponseDto extends SireEnvelopeDto {
  @ApiProperty()
  disclaimer!: string;

  @ApiProperty({ type: SireLimitsDto })
  limits!: SireLimitsDto;

  @ApiProperty({ type: [SireSourceInfoDto] })
  sources!: SireSourceInfoDto[];
}

export class SireDocumentKeyDto {
  @ApiProperty({ example: '01' })
  docTypeCode!: string;

  @ApiProperty({ example: 'F001' })
  series!: string;

  @ApiProperty({ example: '12' })
  number!: string;

  @ApiProperty({ required: false, description: 'Solo RCE.' })
  supplierDocNumber?: string;
}

export class SireCounterpartyDto {
  @ApiProperty({ type: String, nullable: true, example: '6' })
  docTypeCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  docNumber!: string | null;

  @ApiProperty({ type: String, nullable: true })
  name!: string | null;
}

export class SireDocumentItemDto {
  @ApiProperty({ description: 'Referencia interna del documento de origen.' })
  refId!: string;

  @ApiProperty({ type: SireDocumentKeyDto, nullable: true })
  key!: SireDocumentKeyDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Código SUNAT PROVISIONAL; null si no está mapeado.',
  })
  docTypeCode!: string | null;

  @ApiProperty()
  series!: string;

  @ApiProperty()
  number!: string;

  @ApiProperty({ example: '2026-01-05' })
  issueDate!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Solo RCE.' })
  accountingDate!: string | null;

  @ApiProperty({ type: SireCounterpartyDto })
  counterparty!: SireCounterpartyDto;

  @ApiProperty({ example: 'PEN' })
  currencyCode!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '847.46',
    description: 'null si el tratamiento tributario no puede clasificarse.',
  })
  taxableBase!: string | null;

  @ApiProperty({ example: '152.54' })
  igv!: string;

  @ApiProperty({ example: '1000.00' })
  total!: string;

  @ApiProperty({
    example: 'ACCEPTED_MOCK',
    description:
      'Estado INTERNO del POS. Nunca significa aceptación ante SUNAT.',
  })
  internalStatus!: string;

  @ApiProperty({ enum: DATA_QUALITY_FLAGS, isArray: true })
  flags!: DataQualityFlag[];
}

export class SireCurrencyTotalsDto {
  @ApiProperty()
  documents!: number;

  @ApiProperty({ example: '11016.98' })
  taxableBase!: string;

  @ApiProperty({ example: '1983.02' })
  igv!: string;

  @ApiProperty({
    example: '1000.00',
    description: 'Suma de documentos con tratamiento sin clasificar.',
  })
  unclassifiedTotal!: string;

  @ApiProperty({ example: '14000.00' })
  total!: string;
}

export class SireExcludedDto {
  @ApiProperty({
    description:
      'Documentos del periodo que existen pero no son elegibles por estado.',
  })
  notEligibleStatus!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Solo origen POS + RVIE: ventas activas del periodo sin comprobante fiscal. null en los demás casos.',
  })
  salesWithoutFiscalDocument!: number | null;
}

export class SireDocumentsSummaryDto {
  @ApiProperty()
  documentCount!: number;

  @ApiProperty({ type: SireExcludedDto })
  excluded!: SireExcludedDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: {
      $ref: '#/components/schemas/SireCurrencyTotalsDto',
    },
    description:
      'Totales por moneda. Nunca se suman ni convierten monedas distintas.',
  })
  totalsByCurrency!: Record<string, SireCurrencyTotalsDto>;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description:
      'Conteo de documentos por alerta (sobre TODO el periodo, no solo la página).',
  })
  flags!: Record<string, number>;
}

export class SireDocumentsResponseDto extends SireEnvelopeDto {
  @ApiProperty({ enum: SIRE_SOURCES })
  source!: SireSource;

  @ApiProperty({ type: String, nullable: true })
  fixtureSetVersion!: string | null;

  @ApiProperty({ enum: SIRE_REGISTERS })
  register!: SireRegister;

  @ApiProperty({ example: '202601' })
  period!: string;

  @ApiProperty({ example: 'accountingDate - PROVISIONAL (DEMO)' })
  periodRule!: string;

  @ApiProperty({ type: SireDocumentsSummaryDto })
  summary!: SireDocumentsSummaryDto;

  @ApiProperty({ type: [SireDocumentItemDto] })
  items!: SireDocumentItemDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 50 })
  pageSize!: number;

  @ApiProperty({
    description:
      'Documentos que cumplen el filtro `flag` (no el total del periodo; ese está en summary.documentCount).',
  })
  totalItems!: number;
}
