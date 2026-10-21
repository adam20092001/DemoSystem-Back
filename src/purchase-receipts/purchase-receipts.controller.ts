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
import { CancelPurchaseReceiptDto } from './dto/cancel-purchase-receipt.dto';
import { CreatePurchaseReceiptDto } from './dto/create-purchase-receipt.dto';
import {
  PurchaseInvoiceReceiptsSummaryResponseDto,
  PurchaseReceiptResponseDto,
} from './dto/purchase-receipt-response.dto';
import { PurchaseReceiptsService } from './purchase-receipts.service';
import { PurchaseInvoiceReceiptsSummary } from './types/purchase-invoice-receipts-summary';
import { SafePurchaseReceipt } from './types/safe-purchase-receipt';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;
const MANAGE_ROLES = [RoleName.ADMIN] as const;

/**
 * Historial y creación de recepciones físicas ANIDADAS bajo una factura de
 * compra (Fase A5.2b). Mismo prefijo que PurchaseInvoicesController
 * (`purchase-invoices`) — controller SEPARADO a propósito, para no tocar
 * el archivo ya validado de A5.2a; NestJS permite varios controllers bajo
 * el mismo prefijo mientras sus rutas no colisionen (`:id/receipts` nunca
 * colisiona con `:id`, `:id/confirm`, `:id/cancel`).
 */
@ApiTags('Purchase Receipts')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('purchase-invoices')
export class PurchaseInvoiceReceiptsController {
  constructor(
    private readonly purchaseReceiptsService: PurchaseReceiptsService,
  ) {}

  @ApiOperation({
    summary:
      'Historial de recepciones de una factura + resumen pendiente/parcial/completo por línea elegible',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PurchaseInvoiceReceiptsSummaryResponseDto })
  @ApiNotFoundResponse({ description: 'La factura no existe.' })
  @Roles(...READ_ROLES)
  @Get(':id/receipts')
  listReceipts(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PurchaseInvoiceReceiptsSummary> {
    return this.purchaseReceiptsService.listByInvoice(id, user.role);
  }

  @ApiOperation({
    summary: 'Registrar una recepción física de mercadería (ADMIN)',
    description:
      'Solo contra una factura CONFIRMED y únicamente líneas con isReceiptEligible=true. Admite recepciones parciales; la suma de cantidades ACTIVE nunca supera lo facturado. `idempotencyKey` opcional: reenviarla en un reintento devuelve la misma recepción ya creada.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: PurchaseReceiptResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload inválido, línea inexistente/no elegible, o duplicada en la misma recepción.',
  })
  @ApiNotFoundResponse({ description: 'La factura no existe.' })
  @ApiConflictResponse({
    description:
      'La factura no está CONFIRMED, la cantidad excede lo facturado, o no se puede determinar con seguridad la cuenta de reclasificación.',
  })
  @Roles(...MANAGE_ROLES)
  @Post(':id/receipts')
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePurchaseReceiptDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafePurchaseReceipt> {
    return this.purchaseReceiptsService.create({
      purchaseInvoiceId: id,
      receivedDate: dto.receivedDate,
      notes: dto.notes,
      idempotencyKey: dto.idempotencyKey,
      lines: dto.lines,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}

/** Consulta de detalle y anulación de UNA recepción, por su propio id. */
@ApiTags('Purchase Receipts')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('purchase-receipts')
export class PurchaseReceiptsController {
  constructor(
    private readonly purchaseReceiptsService: PurchaseReceiptsService,
  ) {}

  @ApiOperation({ summary: 'Obtener el detalle de una recepción de compra' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PurchaseReceiptResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafePurchaseReceipt> {
    return this.purchaseReceiptsService.findOne(id, user.role);
  }

  @ApiOperation({
    summary: 'Anular una recepción de compra ya ACTIVE (ADMIN)',
    description:
      'Genera movimientos EXIT compensatorios (nunca elimina/edita los ENTRY originales) vía StockMovementEngine; bloquea si provocaría stock negativo. Si la recepción disparó una reclasificación contable, la revierte exactamente vía AccountingEngine — nunca toca el asiento PURCHASE original de la factura.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PurchaseReceiptResponseDto })
  @ApiBadRequestResponse({ description: 'reason faltante o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'La recepción no está ACTIVE, o anularla dejaría stock negativo.',
  })
  @Roles(...MANAGE_ROLES)
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelPurchaseReceiptDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafePurchaseReceipt> {
    return this.purchaseReceiptsService.cancel({
      purchaseReceiptId: id,
      reason: dto.reason,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
