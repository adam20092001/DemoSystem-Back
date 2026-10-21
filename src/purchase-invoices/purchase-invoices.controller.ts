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
import { CancelPurchaseInvoiceDto } from './dto/cancel-purchase-invoice.dto';
import { CreatePurchaseInvoiceDto } from './dto/create-purchase-invoice.dto';
import { ListPurchaseInvoicesQueryDto } from './dto/list-purchase-invoices-query.dto';
import {
  PaginatedPurchaseInvoicesResponseDto,
  PurchaseInvoiceResponseDto,
} from './dto/purchase-invoice-response.dto';
import { UpdatePurchaseInvoiceDto } from './dto/update-purchase-invoice.dto';
import { PurchaseInvoicesService } from './purchase-invoices.service';
import { SafePurchaseInvoice } from './types/safe-purchase-invoice';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;
const MANAGE_ROLES = [RoleName.ADMIN] as const;

/**
 * Facturas de compra universales (Fase A5.2a): ciclo de vida
 * DRAFT -> CONFIRMED -> CANCELLED. Nunca expone recepción física,
 * pagos a proveedor ni ningún efecto sobre inventario — eso queda
 * explícitamente fuera de esta fase (A5.2b en adelante, todavía no
 * implementada).
 */
@ApiTags('Purchase Invoices')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('purchase-invoices')
export class PurchaseInvoicesController {
  constructor(
    private readonly purchaseInvoicesService: PurchaseInvoicesService,
  ) {}

  @ApiOperation({
    summary: 'Listar facturas de compra (paginado, con filtros)',
  })
  @ApiOkResponse({ type: PaginatedPurchaseInvoicesResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListPurchaseInvoicesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafePurchaseInvoice>> {
    return this.purchaseInvoicesService.listDrafts(query, user.role);
  }

  @ApiOperation({ summary: 'Obtener el detalle de una factura de compra' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PurchaseInvoiceResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafePurchaseInvoice> {
    return this.purchaseInvoicesService.findOne(id, user.role);
  }

  @ApiOperation({
    summary: 'Crear una factura de compra (ADMIN; nace DRAFT)',
    description:
      'Puede crearse sin líneas o con líneas incompletas: toda validación tributaria/de cuadre estricta se exige recién al confirmar. currencyCode siempre se toma de CompanySettings vigente, nunca del cliente.',
  })
  @ApiCreatedResponse({ type: PurchaseInvoiceResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload inválido, o el proveedor/producto referenciado no existe.',
  })
  @ApiConflictResponse({ description: 'El proveedor indicado no está activo.' })
  @Roles(...MANAGE_ROLES)
  @Post()
  create(
    @Body() dto: CreatePurchaseInvoiceDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafePurchaseInvoice> {
    return this.purchaseInvoicesService.create({
      supplierId: dto.supplierId,
      documentType: dto.documentType,
      documentSeries: dto.documentSeries,
      documentNumber: dto.documentNumber,
      issueDate: dto.issueDate,
      registrationDate: dto.registrationDate,
      accountingDate: dto.accountingDate,
      dueDate: dto.dueDate,
      paymentTermsDays: dto.paymentTermsDays,
      lines: dto.lines ?? [],
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Editar una factura de compra (ADMIN; solo mientras status=DRAFT)',
    description:
      '`lines`, si se envía, reemplaza el arreglo completo de líneas — nunca un parche línea a línea.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PurchaseInvoiceResponseDto })
  @ApiBadRequestResponse({ description: 'Payload vacío o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'La factura ya no está en DRAFT.' })
  @Roles(...MANAGE_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseInvoiceDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafePurchaseInvoice> {
    return this.purchaseInvoicesService.update({
      purchaseInvoiceId: id,
      documentType: dto.documentType,
      documentSeries: dto.documentSeries,
      documentNumber: dto.documentNumber,
      issueDate: dto.issueDate,
      registrationDate: dto.registrationDate,
      accountingDate: dto.accountingDate,
      dueDate: dto.dueDate,
      paymentTermsDays: dto.paymentTermsDays,
      lines: dto.lines,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Confirmar una factura de compra (ADMIN)',
    description:
      'Congela isReceiptEligible por línea y contabiliza vía AccountingEngine.postPurchaseRecognition(). Falla con 409 si algún mapeo contable requerido (ACCOUNTS_PAYABLE/VAT_RECEIVABLE/PURCHASE_*) todavía no fue configurado por ADMIN.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PurchaseInvoiceResponseDto })
  @ApiBadRequestResponse({ description: 'La factura no tiene ninguna línea.' })
  @ApiNotFoundResponse({
    description: 'No existe, o el periodo contable requerido no existe.',
  })
  @ApiConflictResponse({
    description:
      'Ya no está en DRAFT, el proveedor no está activo, el periodo contable está CERRADO, o falta un mapeo contable.',
  })
  @Roles(...MANAGE_ROLES)
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafePurchaseInvoice> {
    return this.purchaseInvoicesService.confirm({
      purchaseInvoiceId: id,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Anular una factura de compra ya confirmada (ADMIN)',
    description:
      'Revierte el asiento contable ORIGINAL vía AccountingEngine.reverseOriginalForSource(). Nunca modifica inventario (esta fase no mueve stock).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PurchaseInvoiceResponseDto })
  @ApiBadRequestResponse({ description: 'reason faltante o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'La factura no está CONFIRMED.' })
  @Roles(...MANAGE_ROLES)
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelPurchaseInvoiceDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafePurchaseInvoice> {
    return this.purchaseInvoicesService.cancel({
      purchaseInvoiceId: id,
      reason: dto.reason,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
