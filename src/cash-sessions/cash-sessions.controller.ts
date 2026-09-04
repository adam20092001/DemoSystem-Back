import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaginatedResult } from '../common/types/paginated-result';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { CashSessionsService } from './cash-sessions.service';
import {
  CashSessionResponseDto,
  PaginatedCashSessionsResponseDto,
} from './dto/cash-session-response.dto';
import { ListCashSessionsQueryDto } from './dto/list-cash-sessions-query.dto';
import { OpenCashSessionDto } from './dto/open-cash-session.dto';
import { SafeCashSession } from './types/safe-cash-session';

/**
 * Matriz aprobada (Ticket B, Bloque B2 §2): ADMIN/SELLER son los únicos
 * cobradores actuales (WAREHOUSE nunca; MANAGEMENT no abre caja porque hoy
 * no registra Payments). Lectura de historial/detalle amplía a MANAGEMENT
 * (sin restricción de propiedad) — SELLER queda acotado a lo propio en la
 * capa de servicio, nunca solo por el guard de rol.
 */
const OPEN_ROLES = [RoleName.ADMIN, RoleName.SELLER] as const;
const CURRENT_ROLES = [RoleName.ADMIN, RoleName.SELLER] as const;
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.SELLER,
] as const;

@ApiTags('Cash Sessions')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('cash-sessions')
export class CashSessionsController {
  constructor(private readonly cashSessionsService: CashSessionsService) {}

  @ApiOperation({
    summary: 'Abrir una caja (ADMIN/SELLER)',
    description:
      'Siempre manual: nunca se abre automáticamente al iniciar sesión. El servidor fija userId (actor autenticado), status (OPEN) y openedAt — el body nunca los acepta. openingAmount admite 0 (caja sin fondo inicial) pero nunca un valor negativo. Como máximo una caja sin resolver (OPEN o PENDING_APPROVAL) por usuario, protegido por un índice único parcial en base de datos: un segundo intento responde 409, incluso ante dos aperturas simultáneas del mismo usuario.',
  })
  @ApiCreatedResponse({ type: CashSessionResponseDto })
  @ApiBadRequestResponse({
    description: 'openingAmount ausente, mal formado o negativo.',
  })
  @ApiConflictResponse({
    description:
      'El usuario ya tiene una caja sin resolver (OPEN o PENDING_APPROVAL).',
  })
  @Roles(...OPEN_ROLES)
  @Post('open')
  open(
    @Body() dto: OpenCashSessionDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCashSession> {
    return this.cashSessionsService.open({
      openingAmount: dto.openingAmount,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Caja sin resolver del actor autenticado (ADMIN/SELLER)',
    description:
      'Resuelve por userId=actor.id y status IN (OPEN, PENDING_APPROVAL) — nunca CLOSED. El índice único parcial garantiza como máximo una fila coincidente. PENDING_APPROVAL ya se contempla en esta lectura desde este bloque, aunque ningún flujo actual pueda producir ese estado todavía (llega en un bloque posterior).',
  })
  @ApiOkResponse({ type: CashSessionResponseDto })
  @ApiNotFoundResponse({
    description: 'El actor no tiene una caja sin resolver.',
  })
  @Roles(...CURRENT_ROLES)
  @Get('current')
  getCurrent(
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<SafeCashSession> {
    return this.cashSessionsService.getCurrent(actor);
  }

  @ApiOperation({
    summary: 'Historial de cajas (paginado, con filtros)',
    description:
      'ADMIN/MANAGEMENT: todas las cajas, con userId como filtro opcional real. SELLER: SIEMPRE forzado a sus propias cajas — un userId ajeno en la query nunca tiene efecto, se ignora en el servicio. Filtros de fecha (openedFrom/openedTo/closedFrom/closedTo) usan fechas de negocio America/Lima. hasDifference=true filtra differenceAmount<>0; hasDifference=false filtra differenceAmount=0 — sin efecto sobre cajas sin snapshot de cierre (p. ej. OPEN). Orden fijo: openedAt DESC, id DESC.',
  })
  @ApiOkResponse({ type: PaginatedCashSessionsResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros o rango de fechas inválido.' })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListCashSessionsQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeCashSession>> {
    return this.cashSessionsService.list(query, actor);
  }

  @ApiOperation({
    summary: 'Detalle de una caja por ID',
    description:
      'ADMIN/MANAGEMENT: pueden leer cualquier caja. SELLER: solo la suya — una caja de otro usuario responde 404 (nunca 403), mismo criterio ya establecido en Payments para no revelar la existencia cruzada de un recurso ajeno.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CashSessionResponseDto })
  @ApiNotFoundResponse({
    description: 'La caja no existe, o (SELLER) pertenece a otro usuario.',
  })
  @Roles(...READ_ROLES)
  @Get(':id')
  getDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<SafeCashSession> {
    return this.cashSessionsService.getDetail(id, actor);
  }
}
