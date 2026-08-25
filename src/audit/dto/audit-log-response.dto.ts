import { ApiProperty } from '@nestjs/swagger';

/** Identidad mínima segura del actor. Nunca email/role/status/passwordHash. */
export class AuditLogUserResponseDto {
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
 * Fila compacta del listado. Nunca metadata ni ipAddress: no forman parte
 * de esta forma en absoluto (ver GET /audit/:id para el detalle completo).
 */
export class AuditLogListItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    type: AuditLogUserResponseDto,
    nullable: true,
    description:
      'null cuando el evento no tiene actor humano (p. ej. LOGIN_FAILED sobre un usuario inexistente) o el usuario actor fue eliminado.',
  })
  user!: AuditLogUserResponseDto | null;

  @ApiProperty({ example: 'CONFIGURATION' })
  module!: string;

  @ApiProperty({ example: 'CONFIGURATION_UPDATED' })
  action!: string;

  @ApiProperty({ example: 'CompanySettings' })
  entityType!: string;

  @ApiProperty({ type: String, nullable: true })
  entityId!: string | null;

  @ApiProperty()
  description!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/** Respuesta paginada del listado de auditoría, orden fijo createdAt DESC, id DESC. */
export class PaginatedAuditLogsResponseDto {
  @ApiProperty({ type: [AuditLogListItemResponseDto] })
  data!: AuditLogListItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

/**
 * Detalle completo. `ipAddress` está siempre presente como clave: ADMIN ve
 * el valor real (o null si nunca se registró); MANAGEMENT siempre recibe
 * null. `metadata` es exactamente lo almacenado (ya saneado en escritura por
 * AuditService), igual para ambos roles.
 */
export class AuditLogDetailResponseDto extends AuditLogListItemResponseDto {
  @ApiProperty({
    type: Object,
    nullable: true,
    description:
      'JSON saneado en escritura (lista blanca por acción). Nunca se reinterpreta ni se sanea de nuevo en lectura.',
  })
  metadata!: unknown;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Real para ADMIN (o null si nunca se registró); siempre null para MANAGEMENT.',
  })
  ipAddress!: string | null;
}
