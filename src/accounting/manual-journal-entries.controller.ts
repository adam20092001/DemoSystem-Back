import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaginatedResult } from '../common/types/paginated-result';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { CreateManualJournalDraftDto } from './dto/create-manual-journal-draft.dto';
import { ListManualJournalDraftsQueryDto } from './dto/list-manual-journal-drafts-query.dto';
import {
  ManualJournalDraftResponseDto,
  PaginatedManualJournalDraftsResponseDto,
} from './dto/manual-journal-draft-response.dto';
import { ReverseManualJournalEntryDto } from './dto/reverse-manual-journal-entry.dto';
import { UpdateManualJournalDraftDto } from './dto/update-manual-journal-draft.dto';
import { ManualJournalEntriesService } from './manual-journal-entries.service';
import { SafeManualJournalDraft } from './types/manual-journal-entry';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;
const MANAGE_ROLES = [RoleName.ADMIN, RoleName.ACCOUNTANT] as const;

/**
 * Asientos manuales (Fase A4): ciclo de vida DRAFT -> POSTED y reversión
 * controlada. `:id` es SIEMPRE el id del borrador (`ManualJournalDraft`),
 * en las 6 rutas — incluida `reverse`, que internamente localiza y
 * revierte el AccountingEntry definitivo asociado
 * (`draft.postedEntryId`), nunca requiere que el cliente conozca ese id
 * por separado. Nunca expone edición ni eliminación del AccountingEntry
 * definitivo en sí — eso sigue sin existir en todo el dominio (A0-A3).
 */
@ApiTags('Manual Journal Entries')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('accounting/manual-entries')
export class ManualJournalEntriesController {
  constructor(
    private readonly manualJournalEntriesService: ManualJournalEntriesService,
  ) {}

  @ApiOperation({
    summary:
      'Listar borradores de asiento manual (paginado, con filtro de estado)',
  })
  @ApiOkResponse({ type: PaginatedManualJournalDraftsResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListManualJournalDraftsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeManualJournalDraft>> {
    return this.manualJournalEntriesService.listDrafts(query, user.role);
  }

  @ApiOperation({
    summary: 'Obtener el detalle de un borrador de asiento manual',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ManualJournalDraftResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeManualJournalDraft> {
    return this.manualJournalEntriesService.findDraftById(id, user.role);
  }

  @ApiOperation({
    summary:
      'Crear un borrador de asiento manual (ADMIN/ACCOUNTANT; nace DRAFT)',
    description:
      'Puede crearse sin líneas o con líneas incompletas (A4.2): toda validación financiera se exige recién al contabilizar (A4.3), nunca aquí.',
  })
  @ApiCreatedResponse({ type: ManualJournalDraftResponseDto })
  @ApiBadRequestResponse({
    description: 'Payload inválido, o alguna cuenta referenciada no existe.',
  })
  @Roles(...MANAGE_ROLES)
  @Post()
  create(
    @Body() dto: CreateManualJournalDraftDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeManualJournalDraft> {
    return this.manualJournalEntriesService.createDraft({
      accountingDate: dto.accountingDate,
      description: dto.description,
      lines: dto.lines,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary:
      'Editar un borrador (ADMIN/ACCOUNTANT; solo mientras status=DRAFT)',
    description:
      '`lines`, si se envía, reemplaza el arreglo completo de líneas — nunca un parche línea a línea.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ManualJournalDraftResponseDto })
  @ApiBadRequestResponse({ description: 'Payload vacío o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'El borrador ya fue contabilizado (status=POSTED).',
  })
  @Roles(...MANAGE_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateManualJournalDraftDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeManualJournalDraft> {
    return this.manualJournalEntriesService.updateDraft({
      draftId: id,
      accountingDate: dto.accountingDate,
      description: dto.description,
      lines: dto.lines,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Contabilizar un borrador (ADMIN/ACCOUNTANT)',
    description:
      'Valida cuadre/cuentas/periodo y crea el AccountingEntry definitivo vía AccountingEngine, en la misma transacción que marca el borrador POSTED. Irreversible por esta vía (ver POST .../reverse para revertir el asiento ya contabilizado).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ManualJournalDraftResponseDto })
  @ApiBadRequestResponse({
    description:
      'Menos de 2 líneas, línea en cero, cuenta inactiva/no postable, o asiento desbalanceado.',
  })
  @ApiNotFoundResponse({
    description: 'No existe, o el periodo contable requerido no existe.',
  })
  @ApiConflictResponse({
    description: 'Ya fue contabilizado, o el periodo contable está CERRADO.',
  })
  @Roles(...MANAGE_ROLES)
  @Post(':id/post')
  @HttpCode(HttpStatus.OK)
  post(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeManualJournalDraft> {
    return this.manualJournalEntriesService.postDraft({
      draftId: id,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Revertir un asiento manual ya contabilizado (ADMIN/ACCOUNTANT)',
    description:
      'Crea un AccountingEntry REVERSAL vía AccountingEngine; nunca modifica ni elimina el asiento ORIGINAL. Exclusivo de asientos MANUAL — nunca revierte SALE/PAYMENT por esta vía.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ManualJournalDraftResponseDto })
  @ApiBadRequestResponse({ description: 'reason faltante o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'El borrador no está contabilizado, o ya fue revertido anteriormente.',
  })
  @Roles(...MANAGE_ROLES)
  @Post(':id/reverse')
  @HttpCode(HttpStatus.OK)
  reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseManualJournalEntryDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeManualJournalDraft> {
    return this.manualJournalEntriesService.reverseEntry({
      draftId: id,
      reason: dto.reason,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
