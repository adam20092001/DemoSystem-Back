import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
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
import { AccountingSystemKey, RoleName } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaginatedResult } from '../common/types/paginated-result';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import {
  AccountTreeNodeResponseDto,
  ChartAccountResponseDto,
  PaginatedChartAccountsResponseDto,
} from './dto/chart-account-response.dto';
import { CreateAccountDto } from './dto/create-account.dto';
import { ListChartAccountsQueryDto } from './dto/list-chart-accounts-query.dto';
import { ReassignSystemKeyDto } from './dto/reassign-system-key.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { AccountTreeNode } from './types/account-tree-node';
import { SafeChartAccount } from './types/safe-chart-account';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;
const MUTATE_ROLES = [RoleName.ADMIN] as const;

/**
 * Plan de cuentas jerárquico PCGE (Fase A1 — A1.2). Recurso NUEVO y
 * separado de `GET /accounts` (Fase 8, AccountsController): ese endpoint
 * sigue siendo, sin ningún cambio de contrato, el listado acotado de las
 * seis cuentas de sistema (ver AccountingService.listAccounts()); este
 * es el plan de cuentas jerárquico completo, con o sin mapeo. Mismo
 * alcance de roles que AccountingEntriesController/AccountsController:
 * ni SELLER ni WAREHOUSE tienen ningún acceso (A1.5).
 */
@ApiTags('Chart of Accounts')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('chart-of-accounts')
export class ChartOfAccountsController {
  constructor(
    private readonly chartOfAccountsService: ChartOfAccountsService,
  ) {}

  @ApiOperation({
    summary: 'Listar el plan de cuentas (paginado, con filtros)',
    description:
      'Incluye las seis cuentas de sistema (Fase 8) y cualquier cuenta PCGE agregada después, con su jerarquía/postable/status. `normalBalance` es derivado de `type`, nunca persistido.',
  })
  @ApiOkResponse({ type: PaginatedChartAccountsResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListChartAccountsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeChartAccount>> {
    return this.chartOfAccountsService.listAccounts(query, user.role);
  }

  @ApiOperation({
    summary: 'Obtener el árbol jerárquico completo del plan de cuentas',
    description:
      'Sin paginar (un plan de cuentas, incluso un PCGE completo, es trivial de cargar en memoria). Cada nodo lleva sus propios `children` ya anidados, ordenados por code.',
  })
  @ApiOkResponse({ type: [AccountTreeNodeResponseDto] })
  @Roles(...READ_ROLES)
  @Get('tree')
  tree(@CurrentUser() user: AuthenticatedUser): Promise<AccountTreeNode[]> {
    return this.chartOfAccountsService.getAccountTree(user.role);
  }

  @ApiOperation({ summary: 'Obtener el detalle de una cuenta' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ChartAccountResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeChartAccount> {
    return this.chartOfAccountsService.findAccountById(id, user.role);
  }

  @ApiOperation({
    summary: 'Crear una cuenta del plan de cuentas (ADMIN; nace ACTIVE)',
    description:
      'Nace sin systemKey (sin mapeo automático): asignarlo es una operación separada y explícita (PATCH /chart-of-accounts/system-keys/:systemKey). Si se envía parentId, la cuenta padre debe estar activa y marcada isPostable=false.',
  })
  @ApiCreatedResponse({ type: ChartAccountResponseDto })
  @ApiBadRequestResponse({ description: 'Payload inválido.' })
  @ApiConflictResponse({
    description: 'code duplicado, o padre no activo / marcado como postable.',
  })
  @ApiNotFoundResponse({ description: 'parentId no existe.' })
  @Roles(...MUTATE_ROLES)
  @Post()
  create(
    @Body() dto: CreateAccountDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeChartAccount> {
    return this.chartOfAccountsService.createAccount({
      code: dto.code,
      name: dto.name,
      type: dto.type,
      parentId: dto.parentId,
      isPostable: dto.isPostable,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Actualizar una cuenta (ADMIN)',
    description:
      'code/systemKey/status nunca son editables aquí: code es inmutable, systemKey solo se reasigna vía el endpoint dedicado, status se administra vía activate/deactivate. Cambiar `type` se rechaza (409) si la cuenta ya tiene asientos históricos. Marcar isPostable=true se rechaza si la cuenta tiene subcuentas.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ChartAccountResponseDto })
  @ApiBadRequestResponse({
    description: 'Payload vacío, auto-padre, o ciclo indirecto.',
  })
  @ApiNotFoundResponse({ description: 'No existe, o parentId no existe.' })
  @ApiConflictResponse({
    description:
      'code duplicado, padre no activo/postable, tipo bloqueado por historial, isPostable=true con subcuentas, o isPostable=false en una cuenta de sistema (systemKey no nulo).',
  })
  @Roles(...MUTATE_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccountDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeChartAccount> {
    return this.chartOfAccountsService.updateAccount({
      accountId: id,
      name: dto.name,
      parentId: dto.parentId,
      type: dto.type,
      isPostable: dto.isPostable,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Activar una cuenta (ADMIN)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ChartAccountResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'Ya está ACTIVE, o su padre no está ACTIVE.',
  })
  @Roles(...MUTATE_ROLES)
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeChartAccount> {
    return this.chartOfAccountsService.activateAccount({
      accountId: id,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Desactivar una cuenta (ADMIN)',
    description:
      'Bloqueado (409) para cualquier cuenta de sistema (systemKey no nulo) — AccountingEngine la sigue necesitando para resolver asientos nuevos. Nunca borra ni reescribe ningún asiento histórico.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ChartAccountResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'Ya está INACTIVE, es una cuenta de sistema, o tiene subcuentas activas.',
  })
  @Roles(...MUTATE_ROLES)
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeChartAccount> {
    return this.chartOfAccountsService.deactivateAccount({
      accountId: id,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary:
      'Reasignar qué cuenta sostiene un systemKey (ADMIN) — capacidad técnica de A1.3',
    description:
      'Mueve el mapeo de un AccountingSystemKey hacia otra cuenta activa y postable. NUNCA toca ningún AccountingEntryLine histórico: AccountingEngine sigue resolviendo por Account.systemKey sin cambios, así que solo los asientos NUEVOS de ese systemKey, a partir de este instante, usan la cuenta nueva. Esta capacidad existe pero A1 no la ejerce sobre ninguna de las seis cuentas de sistema originales (ninguna reasignación real queda activada por esta fase).',
  })
  @ApiParam({ name: 'systemKey', enum: AccountingSystemKey })
  @ApiOkResponse({ type: ChartAccountResponseDto })
  @ApiBadRequestResponse({ description: 'systemKey no es un valor válido.' })
  @ApiNotFoundResponse({ description: 'La cuenta destino no existe.' })
  @ApiConflictResponse({
    description:
      'La cuenta destino no está activa, no es postable, o ya sostiene otro systemKey.',
  })
  @Roles(...MUTATE_ROLES)
  @Patch('system-keys/:systemKey')
  reassignSystemKey(
    @Param('systemKey', new ParseEnumPipe(AccountingSystemKey))
    systemKey: AccountingSystemKey,
    @Body() dto: ReassignSystemKeyDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeChartAccount> {
    return this.chartOfAccountsService.reassignSystemKey({
      systemKey,
      targetAccountId: dto.accountId,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
