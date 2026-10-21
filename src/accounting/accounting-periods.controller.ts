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
import { AccountingPeriodsService } from './accounting-periods.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaginatedResult } from '../common/types/paginated-result';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import {
  AccountingPeriodResponseDto,
  PaginatedAccountingPeriodsResponseDto,
} from './dto/accounting-period-response.dto';
import { CreateAccountingPeriodDto } from './dto/create-accounting-period.dto';
import { ListAccountingPeriodsQueryDto } from './dto/list-accounting-periods-query.dto';
import { SafeAccountingPeriod } from './types/safe-accounting-period';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;
const MUTATE_ROLES = [RoleName.ADMIN] as const;

/**
 * Administración de periodos contables mensuales (Fase A2.1/A2.6). Mismo
 * alcance de roles que el resto del dominio contable: ni SELLER ni
 * WAREHOUSE tienen ningún acceso; MANAGEMENT solo lee. La creación de un
 * periodo aquí es siempre MANUAL (ADMIN inicializando por adelantado) —
 * nunca reemplaza la auto-creación implícita y silenciosa de
 * AccountingEngine cuando un posteo normal necesita el mes en curso, que
 * nunca pasa por este controller.
 */
@ApiTags('Accounting Periods')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('accounting/periods')
export class AccountingPeriodsController {
  constructor(
    private readonly accountingPeriodsService: AccountingPeriodsService,
  ) {}

  @ApiOperation({
    summary: 'Listar periodos contables (paginado, con filtros)',
    description: 'Orden fijo: year descendente, month descendente.',
  })
  @ApiOkResponse({ type: PaginatedAccountingPeriodsResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListAccountingPeriodsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeAccountingPeriod>> {
    return this.accountingPeriodsService.listPeriods(query, user.role);
  }

  @ApiOperation({ summary: 'Obtener el detalle de un periodo contable' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AccountingPeriodResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeAccountingPeriod> {
    return this.accountingPeriodsService.findPeriodById(id, user.role);
  }

  @ApiOperation({
    summary: 'Abrir/crear manualmente un periodo contable (ADMIN; nace OPEN)',
    description:
      'Nunca es necesario para la operación comercial normal: AccountingEngine crea automáticamente el periodo del mes en curso como OPEN la primera vez que lo necesita. Este endpoint es para que ADMIN inicialice por adelantado un periodo futuro.',
  })
  @ApiCreatedResponse({ type: AccountingPeriodResponseDto })
  @ApiBadRequestResponse({ description: 'year/month fuera de rango.' })
  @ApiConflictResponse({ description: 'El periodo ya existe.' })
  @Roles(...MUTATE_ROLES)
  @Post()
  create(
    @Body() dto: CreateAccountingPeriodDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeAccountingPeriod> {
    return this.accountingPeriodsService.createPeriod({
      year: dto.year,
      month: dto.month,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Cerrar un periodo contable OPEN (ADMIN)',
    description:
      'A partir de este cierre, AccountingEngine rechaza con 409 cualquier posteo nuevo (venta, pago o su reversión) cuya fecha contable caiga en este periodo.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AccountingPeriodResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'Ya está cerrado.' })
  @Roles(...MUTATE_ROLES)
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeAccountingPeriod> {
    return this.accountingPeriodsService.closePeriod({
      periodId: id,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Reabrir un periodo contable CLOSED (ADMIN)',
    description:
      'Siempre una acción explícita y auditada: ningún proceso automático reabre un periodo CLOSED.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AccountingPeriodResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'Ya está abierto.' })
  @Roles(...MUTATE_ROLES)
  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeAccountingPeriod> {
    return this.accountingPeriodsService.reopenPeriod({
      periodId: id,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
