import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { AuditQueryService } from './audit-query.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaginatedResult } from '../common/types/paginated-result';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { AuditQueryDto } from './dto/audit-query.dto';
import {
  AuditLogDetailResponseDto,
  PaginatedAuditLogsResponseDto,
} from './dto/audit-log-response.dto';
import {
  SafeAuditLogDetail,
  SafeAuditLogListItem,
} from './types/safe-audit-log';

const READ_ROLES = [RoleName.ADMIN, RoleName.MANAGEMENT] as const;

/**
 * Bitácora de auditoría de solo lectura (Fase 10, Bloque E). Controller
 * delgado: toda la lógica vive en AuditQueryService — nunca se inyecta
 * AuditService aquí (esa infraestructura de escritura es de otro dominio).
 * Ni esta ni ninguna otra ruta de este controller genera una fila de
 * auditoría: leer el registro de auditoría nunca se audita a sí mismo.
 */
@ApiTags('Audit')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('audit')
export class AuditController {
  constructor(private readonly auditQueryService: AuditQueryService) {}

  @ApiOperation({
    summary: 'Listar el registro de auditoría (paginado, con filtros)',
    description:
      'Bitácora de solo lectura de acciones críticas del sistema (identidad de quién, qué, cuándo, sobre qué entidad). No es un log técnico de cada request/respuesta, no constituye cumplimiento legal/fiscal. Fila compacta: sin metadata ni dirección IP (ver el detalle en GET /audit/:id). Orden fijo: createdAt descendente e id descendente como desempate (eventos más recientes primero). Los filtros de fecha usan el día de negocio America/Lima.',
  })
  @ApiOkResponse({ type: PaginatedAuditLogsResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros inválidos.' })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: AuditQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeAuditLogListItem>> {
    return this.auditQueryService.list(query, actor.role);
  }

  @ApiOperation({
    summary: 'Obtener el detalle de un registro de auditoría',
    description:
      'Incluye metadata (JSON ya saneado en escritura, nunca reinterpretado en lectura) y dirección IP. La dirección IP solo es visible para ADMIN: MANAGEMENT siempre recibe ipAddress=null, aunque el registro tenga un valor real almacenado.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AuditLogDetailResponseDto })
  @ApiBadRequestResponse({ description: 'id no es un UUID válido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<SafeAuditLogDetail> {
    return this.auditQueryService.findOne(id, actor.role);
  }
}
