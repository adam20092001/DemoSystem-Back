import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { ApproveCashSessionDto } from './dto/approve-cash-session.dto';
import {
  CashSessionDetailResponseDto,
  CashSessionResponseDto,
  PaginatedCashSessionsResponseDto,
} from './dto/cash-session-response.dto';
import { CloseCashSessionDto } from './dto/close-cash-session.dto';
import { ListCashSessionsQueryDto } from './dto/list-cash-sessions-query.dto';
import { OpenCashSessionDto } from './dto/open-cash-session.dto';
import { RejectCashSessionDto } from './dto/reject-cash-session.dto';
import {
  SafeCashSession,
  SafeCashSessionDetail,
} from './types/safe-cash-session';

/**
 * Matriz aprobada (Ticket B, Bloques B2+B3): ADMIN/SELLER son los únicos
 * cobradores actuales (WAREHOUSE nunca; MANAGEMENT no abre/cierra caja
 * porque hoy no registra Payments). Lectura de historial/detalle amplía a
 * MANAGEMENT (sin restricción de propiedad) — SELLER queda acotado a lo
 * propio en la capa de servicio, nunca solo por el guard de rol.
 * Aprobación/rechazo de un descuadre son exclusivos de ADMIN/MANAGEMENT
 * (nunca SELLER): la autorrevisión (session.userId === actor.id) se
 * rechaza en el servicio, nunca aquí.
 */
const OPEN_ROLES = [RoleName.ADMIN, RoleName.SELLER] as const;
const CURRENT_ROLES = [RoleName.ADMIN, RoleName.SELLER] as const;
const CLOSE_ROLES = [RoleName.ADMIN, RoleName.SELLER] as const;
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.SELLER,
] as const;
const REVIEW_ROLES = [RoleName.ADMIN, RoleName.MANAGEMENT] as const;

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
    summary: 'Cerrar la caja actual del actor autenticado (ADMIN/SELLER)',
    description:
      'Opera SIEMPRE sobre la caja sin resolver del actor autenticado — nunca acepta una cashSessionId/userId arbitraria. countedCashAmount es obligatorio (decimal no negativo, texto, máximo 2 decimales). expectedCashAmount se calcula en el servidor como openingAmount + suma de Payment ACTIVE vinculados cuyo snapshot paymentMethodAffectsCashDrawer=true (nunca el PaymentMethod actual). differenceAmount = countedCashAmount - expectedCashAmount. Si differenceAmount=0: cierre directo a CLOSED, sin revisor, closingObservation opcional. Si differenceAmount<>0: closingObservation es obligatoria y no en blanco (400 si falta), y la caja pasa a PENDING_APPROVAL en vez de cerrarse. Solo OPEN puede cerrarse: PENDING_APPROVAL responde 409 (inmutable mientras está pendiente); sin caja sin resolver responde 404.',
  })
  @ApiOkResponse({ type: CashSessionResponseDto })
  @ApiBadRequestResponse({
    description:
      'countedCashAmount ausente/mal formado/negativo, o closingObservation ausente/en blanco cuando el cierre resulta en descuadre.',
  })
  @ApiNotFoundResponse({
    description: 'El actor no tiene una caja sin resolver.',
  })
  @ApiConflictResponse({
    description:
      'La caja ya está PENDING_APPROVAL (no puede cerrarse de nuevo).',
  })
  @Roles(...CLOSE_ROLES)
  @Post('current/close')
  @HttpCode(HttpStatus.OK)
  close(
    @Body() dto: CloseCashSessionDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCashSession> {
    return this.cashSessionsService.close({
      countedCashAmount: dto.countedCashAmount,
      closingObservation: dto.closingObservation,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Aprobar el descuadre de una caja pendiente (ADMIN/MANAGEMENT)',
    description:
      'Transición PENDING_APPROVAL -> CLOSED. NUNCA recalcula expectedCashAmount/countedCashAmount/differenceAmount/el resumen por método: acepta exactamente el snapshot ya congelado al momento del cierre solicitado. Un usuario nunca puede aprobar su propia caja (403), sin importar su rol activo. Transición atómica condicional: si la caja ya fue resuelta por otra operación concurrente (aprobación o rechazo), responde 409 en vez de sobrescribir un estado ya resuelto.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CashSessionResponseDto })
  @ApiNotFoundResponse({ description: 'La caja no existe.' })
  @ApiForbiddenResponse({
    description:
      'Rol sin permiso, o intento de aprobar la propia caja (autorrevisión prohibida).',
  })
  @ApiConflictResponse({
    description:
      'La caja no está PENDING_APPROVAL (ya fue aprobada/rechazada por otra operación, o nunca tuvo un descuadre pendiente).',
  })
  @Roles(...REVIEW_ROLES)
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveCashSessionDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCashSession> {
    return this.cashSessionsService.approve({
      cashSessionId: id,
      comment: dto.comment,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Rechazar el descuadre de una caja pendiente (ADMIN/MANAGEMENT)',
    description:
      'Transición PENDING_APPROVAL -> OPEN. El snapshot de cierre rechazado se limpia por completo de CashSession (closeRequestedAt/expectedCashAmount/countedCashAmount/differenceAmount/closingObservation vuelven a NULL) y sus filas de CashSessionPaymentMethodSummary se eliminan — la única evidencia histórica que sobrevive es la propia auditoría, con el snapshot previo y el motivo. reason es obligatorio y no en blanco (400 si falta). Un usuario nunca puede rechazar su propia caja (403). Tras el rechazo, el operador puede cerrar de nuevo con un conteo distinto: ese nuevo cierre recalcula desde cero, sin ningún residuo del intento rechazado. Transición atómica condicional, mismo criterio de 409 que approve.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CashSessionResponseDto })
  @ApiBadRequestResponse({ description: 'reason ausente o en blanco.' })
  @ApiNotFoundResponse({ description: 'La caja no existe.' })
  @ApiForbiddenResponse({
    description:
      'Rol sin permiso, o intento de rechazar la propia caja (autorrevisión prohibida).',
  })
  @ApiConflictResponse({
    description:
      'La caja no está PENDING_APPROVAL (ya fue aprobada/rechazada por otra operación, o nunca tuvo un descuadre pendiente).',
  })
  @Roles(...REVIEW_ROLES)
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectCashSessionDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCashSession> {
    return this.cashSessionsService.reject({
      cashSessionId: id,
      reason: dto.reason,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Caja sin resolver del actor autenticado (ADMIN/SELLER)',
    description:
      'Resuelve por userId=actor.id y status IN (OPEN, PENDING_APPROVAL) — nunca CLOSED. El índice único parcial garantiza como máximo una fila coincidente. Mientras OPEN incluye totales EN VIVO (liveCollectionsTotal/liveCashCollectionsTotal/liveExpectedCashAmount/liveBreakdownByMethod), recalculados en cada lectura a partir de los Payment ACTIVE vinculados vigentes — nunca persistidos. Mientras PENDING_APPROVAL, los campos live* son null y breakdownByMethod trae el desglose YA CONGELADO al momento del cierre solicitado.',
  })
  @ApiOkResponse({ type: CashSessionDetailResponseDto })
  @ApiNotFoundResponse({
    description: 'El actor no tiene una caja sin resolver.',
  })
  @Roles(...CURRENT_ROLES)
  @Get('current')
  getCurrent(
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<SafeCashSessionDetail> {
    return this.cashSessionsService.getCurrent(actor);
  }

  @ApiOperation({
    summary: 'Historial de cajas (paginado, con filtros)',
    description:
      'ADMIN/MANAGEMENT: todas las cajas, con userId como filtro opcional real. SELLER: SIEMPRE forzado a sus propias cajas — un userId ajeno en la query nunca tiene efecto, se ignora en el servicio. Filtros de fecha (openedFrom/openedTo/closedFrom/closedTo) usan fechas de negocio America/Lima. hasDifference=true filtra differenceAmount<>0; hasDifference=false filtra differenceAmount=0 — sin efecto sobre cajas sin snapshot de cierre (p. ej. OPEN). Orden fijo: openedAt DESC, id DESC. Respuesta liviana a propósito, sin desglose por método por fila (ver GET /cash-sessions/:id para el detalle enriquecido).',
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
      'ADMIN/MANAGEMENT: pueden leer cualquier caja. SELLER: solo la suya — una caja de otro usuario responde 404 (nunca 403), mismo criterio ya establecido en Payments para no revelar la existencia cruzada de un recurso ajeno. Mismo enriquecimiento live*/breakdownByMethod que GET /current según el estado.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CashSessionDetailResponseDto })
  @ApiNotFoundResponse({
    description: 'La caja no existe, o (SELLER) pertenece a otro usuario.',
  })
  @Roles(...READ_ROLES)
  @Get(':id')
  getDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<SafeCashSessionDetail> {
    return this.cashSessionsService.getDetail(id, actor);
  }
}
