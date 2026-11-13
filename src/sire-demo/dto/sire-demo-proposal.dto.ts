import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { PERIOD_PATTERN } from '../core/period';
import { SIRE_REGISTERS, SIRE_SOURCES } from '../core/types';
import type { SireRegister, SireSource } from '../core/types';
import { SIRE_DEMO_MAX_PAGE_SIZE } from '../sire-demo.constants';
import { SireEnvelopeDto } from './sire-demo-response.dto';

export const SIRE_PROPOSAL_STATUSES = ['IMPORTED', 'DISCARDED'] as const;
export type SireProposalStatus = (typeof SIRE_PROPOSAL_STATUSES)[number];

/** Campos de texto del formulario multipart (el archivo viaja en `file`). */
export class UploadSireProposalDto {
  @ApiProperty({ enum: SIRE_SOURCES })
  @IsIn(SIRE_SOURCES, { message: 'source debe ser POS o DEMO_FIXTURES' })
  source!: SireSource;

  @ApiProperty({ enum: SIRE_REGISTERS })
  @IsIn(SIRE_REGISTERS, { message: 'register debe ser RVIE o RCE' })
  register!: SireRegister;

  @ApiProperty({ example: '202601', description: 'Periodo YYYYMM.' })
  @Matches(PERIOD_PATTERN, {
    message: 'period debe tener formato YYYYMM con mes 01-12',
  })
  period!: string;
}

/** Cuerpo multipart documentado en Swagger (incluye el archivo). */
export class UploadSireProposalBodyDto extends UploadSireProposalDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'Archivo .txt DEMO_V1 (máx. 2 MB, 5000 filas).',
  })
  file!: unknown;
}

export class ListSireProposalsQueryDto {
  @ApiPropertyOptional({ enum: SIRE_SOURCES })
  @IsOptional()
  @IsIn(SIRE_SOURCES, { message: 'source debe ser POS o DEMO_FIXTURES' })
  source?: SireSource;

  @ApiPropertyOptional({ enum: SIRE_REGISTERS })
  @IsOptional()
  @IsIn(SIRE_REGISTERS, { message: 'register debe ser RVIE o RCE' })
  register?: SireRegister;

  @ApiPropertyOptional({ example: '202601' })
  @IsOptional()
  @Matches(PERIOD_PATTERN, {
    message: 'period debe tener formato YYYYMM con mes 01-12',
  })
  period?: string;

  @ApiPropertyOptional({ enum: SIRE_PROPOSAL_STATUSES })
  @IsOptional()
  @IsIn(SIRE_PROPOSAL_STATUSES, {
    message: 'status debe ser IMPORTED o DISCARDED',
  })
  status?: SireProposalStatus;

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

export class SireProposalUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  username!: string;
}

export class SireProposalDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: SIRE_SOURCES })
  source!: SireSource;

  @ApiProperty({ enum: SIRE_REGISTERS })
  register!: SireRegister;

  @ApiProperty({ example: '202601' })
  period!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'demo-fixtures-v1',
    description: 'Versión del conjunto de fixtures; null para POS.',
  })
  fixtureSetVersion!: string | null;

  @ApiProperty()
  fileName!: string;

  @ApiProperty()
  fileSizeBytes!: number;

  @ApiProperty({ description: 'SHA-256 (hex) del archivo cargado.' })
  fileHash!: string;

  @ApiProperty()
  rowCount!: number;

  @ApiProperty({ enum: SIRE_PROPOSAL_STATUSES })
  status!: SireProposalStatus;

  @ApiProperty({
    description:
      'true si está IMPORTED y su origen está disponible en este ambiente (apta para conciliar en S3).',
  })
  reconcilable!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: SireProposalUserDto })
  createdBy!: SireProposalUserDto;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  discardedAt!: string | null;

  @ApiProperty({ nullable: true, type: SireProposalUserDto })
  discardedBy!: SireProposalUserDto | null;
}

export class SireProposalResponseDto extends SireEnvelopeDto {
  @ApiProperty({
    description:
      'true si el archivo ya estaba importado y activo: se devuelve la propuesta existente sin duplicar nada.',
  })
  reused!: boolean;

  @ApiProperty({ type: SireProposalDto })
  proposal!: SireProposalDto;
}

export class SireProposalListResponseDto extends SireEnvelopeDto {
  @ApiProperty({ type: [SireProposalDto] })
  items!: SireProposalDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  totalItems!: number;
}
