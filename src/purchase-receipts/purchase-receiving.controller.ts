import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiConflictResponse,
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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaginatedResult } from '../common/types/paginated-result';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { ListReceivableInvoicesQueryDto } from './dto/list-receivable-invoices-query.dto';
import {
  PaginatedReceivableInvoicesResponseDto,
  ReceivableInvoiceDetailResponseDto,
} from './dto/receivable-invoice-response.dto';
import { PurchaseReceivingService } from './purchase-receiving.service';
import {
  ReceivableInvoiceDetail,
  ReceivableInvoiceListItem,
} from './types/receivable-invoice';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;

/**
 * Vistas de RECEPCIÓN para almacén (R1). Prefijo propio
 * `purchase-receiving` (distinto de `purchase-invoices`) a propósito: así no
 * compite con `GET /purchase-invoices/:id` (que tiene ParseUUIDPipe y
 * respondería 400 ante un segmento literal) ni abre la factura completa a
 * WAREHOUSE. Ninguna respuesta contiene montos ni identificadores contables.
 * La recepción en sí se registra con el endpoint ya existente
 * `POST /purchase-invoices/:id/receipts` (ADMIN, WAREHOUSE).
 */
@ApiTags('Purchase Receiving')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('purchase-receiving')
export class PurchaseReceivingController {
  constructor(
    private readonly purchaseReceivingService: PurchaseReceivingService,
  ) {}

  @ApiOperation({
    summary:
      'Facturas de compra CONFIRMED con líneas elegibles pendientes de recepción (ADMIN, WAREHOUSE, MANAGEMENT, ACCOUNTANT)',
    description:
      'Solo datos de identificación y cantidad de líneas pendientes; sin ningún monto. La cantidad pendiente descuenta únicamente recepciones ACTIVE: anular una recepción vuelve a dejar pendiente su cantidad.',
  })
  @ApiOkResponse({ type: PaginatedReceivableInvoicesResponseDto })
  @Roles(...READ_ROLES)
  @Get('invoices')
  listInvoices(
    @Query() query: ListReceivableInvoicesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<ReceivableInvoiceListItem>> {
    return this.purchaseReceivingService.listReceivableInvoices(
      query,
      user.role,
    );
  }

  @ApiOperation({
    summary:
      'Líneas elegibles de una factura CONFIRMED con cantidades facturada/recibida/pendiente (ADMIN, WAREHOUSE, MANAGEMENT, ACCOUNTANT)',
    description:
      'Sin precios, costos, bases, impuestos ni ids contables. `purchaseInvoiceLineId` de cada línea es el valor a enviar en POST /purchase-invoices/:id/receipts.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ReceivableInvoiceDetailResponseDto })
  @ApiNotFoundResponse({ description: 'La factura no existe.' })
  @ApiConflictResponse({ description: 'La factura no está CONFIRMED.' })
  @Roles(...READ_ROLES)
  @Get('invoices/:id')
  findInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReceivableInvoiceDetail> {
    return this.purchaseReceivingService.findReceivableInvoice(id, user.role);
  }
}
