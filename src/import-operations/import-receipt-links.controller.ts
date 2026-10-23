import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { CancelImportReceiptLinkDto } from './dto/cancel-import-receipt-link.dto';
import { CreateImportReceiptLinkDto } from './dto/create-import-receipt-link.dto';
import {
  CostAttributionPreviewResponseDto,
  ImportReceiptLinkResponseDto,
  ShipmentLineReceptionSummaryResponseDto,
} from './dto/import-receipt-link-response.dto';
import { ImportReceiptLinksService } from './import-receipt-links.service';
import { CostAttributionPreview } from './types/cost-attribution-preview';
import {
  SafeImportReceiptLink,
  SafeShipmentLineReceptionSummary,
} from './types/safe-import-receipt-link';

const WRITE_ROLES = [RoleName.ADMIN] as const;
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;

/**
 * Vínculo entre el cargamento embarcado (Fase B1) y la mercadería
 * físicamente recibida (Fase A5.2b) — Fase B3. Nunca mueve inventario ni
 * genera efecto contable; ver ImportReceiptLinksService.
 */
@ApiTags('Import Operations')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('import-shipment-lines')
export class ImportShipmentLineReceiptLinksController {
  constructor(
    private readonly importReceiptLinksService: ImportReceiptLinksService,
  ) {}

  @ApiOperation({
    summary:
      'Listar los vínculos de recepción de una línea de embarque, con cantidades y estado derivados',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ShipmentLineReceptionSummaryResponseDto })
  @ApiNotFoundResponse({ description: 'La línea de embarque no existe.' })
  @Roles(...READ_ROLES)
  @Get(':id/receipt-links')
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeShipmentLineReceptionSummary> {
    return this.importReceiptLinksService.listByShipmentLine(id, user.role);
  }

  @ApiOperation({
    summary:
      'Vincular una línea de embarque ARRIVED a una recepción de compra ACTIVE (solo ADMIN)',
    description:
      'Nunca mueve inventario ni genera efecto contable. Verifica consistencia de producto/factura y nunca excede la cantidad embarcada ni la físicamente recibida, bajo lock transaccional (protección real de concurrencia). idempotencyKey opcional: reenviarla devuelve el mismo vínculo.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: ImportReceiptLinkResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload inválido, recepción inexistente, o inconsistencia de producto/factura.',
  })
  @ApiNotFoundResponse({ description: 'La línea de embarque no existe.' })
  @ApiConflictResponse({
    description:
      'El embarque no está ARRIVED, la recepción no está ACTIVE, vínculo duplicado, o excede lo embarcado/recibido.',
  })
  @Roles(...WRITE_ROLES)
  @Post(':id/receipt-links')
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateImportReceiptLinkDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportReceiptLink> {
    return this.importReceiptLinksService.create({
      importShipmentLineId: id,
      purchaseReceiptLineId: dto.purchaseReceiptLineId,
      linkedQuantity: dto.linkedQuantity,
      idempotencyKey: dto.idempotencyKey,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}

/** Cancelación explícita (desvínculo) de UN vínculo de recepción, por su propio id (Fase B3). */
@ApiTags('Import Operations')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('import-receipt-links')
export class ImportReceiptLinksController {
  constructor(
    private readonly importReceiptLinksService: ImportReceiptLinksService,
  ) {}

  @ApiOperation({
    summary:
      'Cancelar (desvincular) un vínculo de recepción ACTIVE (solo ADMIN)',
    description:
      'Única vía de corrección explícita y auditable — nunca una eliminación física. Necesaria antes de poder anular la recepción física referenciada.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportReceiptLinkResponseDto })
  @ApiBadRequestResponse({ description: 'reason faltante o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'El vínculo no está ACTIVE.' })
  @Roles(...WRITE_ROLES)
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelImportReceiptLinkDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportReceiptLink> {
    return this.importReceiptLinksService.cancel({
      importReceiptLinkId: id,
      reason: dto.reason,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}

/** Previsualización de atribución de costo de importación por recepción física, por línea de asignación (Fase B3). */
@ApiTags('Import Operations')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('import-expense-allocations')
export class ImportExpenseAllocationCostPreviewController {
  constructor(
    private readonly importReceiptLinksService: ImportReceiptLinksService,
  ) {}

  @ApiOperation({
    summary:
      'Previsualizar la atribución de costo de una línea de asignación por las recepciones físicas reales vinculadas',
    description:
      'PURA, nunca persiste ni aplica nada financiero. Reutiliza el mismo cálculo de reparto proporcional exacto de B2. financialStatus siempre indica PENDING_FX o PENDING_ACCOUNTING_POLICY: esto NUNCA constituye una aprobación de capitalización.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'ImportExpenseAllocation.id (B2).',
  })
  @ApiOkResponse({ type: CostAttributionPreviewResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id/cost-attribution-preview')
  previewCostAttribution(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CostAttributionPreview> {
    return this.importReceiptLinksService.previewCostAttribution(id, user.role);
  }
}
