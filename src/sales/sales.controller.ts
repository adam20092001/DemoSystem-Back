import {
  Body,
  Controller,
  Get,
  Header,
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
  ApiProduces,
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
import { CancelSaleDto } from './dto/cancel-sale.dto';
import { ConvertQuoteToSaleDto } from './dto/convert-quote-to-sale.dto';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ListSalesQueryDto } from './dto/list-sales-query.dto';
import {
  PaginatedSalesResponseDto,
  SaleResponseDto,
} from './dto/sale-response.dto';
import { SaleDocumentRenderer } from './printing/sale-document.renderer';
import { SalesService } from './sales.service';
import { SafeSale, SafeSaleListItem } from './types/safe-sale';

/**
 * SELLER tiene acceso Total salvo anulación (matriz aprobada del plan de
 * Fase 6): sin distinción con ADMIN en creación/conversión/entrega/lectura.
 * Solo ADMIN puede anular (a diferencia de Quotes, donde SELLER también
 * podía aceptar/rechazar).
 */
const WRITE_ROLES = [RoleName.ADMIN, RoleName.SELLER] as const;
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.SELLER,
  RoleName.MANAGEMENT,
] as const;
const CANCEL_ROLES = [RoleName.ADMIN] as const;

@ApiTags('Sales')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('sales')
export class SalesController {
  constructor(
    private readonly salesService: SalesService,
    private readonly renderer: SaleDocumentRenderer,
  ) {}

  @ApiOperation({
    summary: 'Registrar una venta directa (nace confirmada)',
    description:
      'POST /sales confirma la venta inmediatamente: no existe un estado previo de borrador. El precio de cada ítem se toma siempre de Product.salePrice vigente; el cliente nunca lo controla. El stock actual se valida al confirmar y, si es suficiente, se descuenta mediante movimientos de inventario reales. Admite un pago inicial opcional (`payment`), registrado en la misma transacción. Una venta a Público general o a un cliente bloqueado solo se confirma si el saldo pendiente resultante es exactamente 0: sin pago inicial, o con uno que no salde el total por completo, esa venta no puede confirmarse. Ticket B, Bloque B4: si se incluye `payment`, el actor autenticado debe tener su propia caja (CashSession) abierta — de lo contrario la venta completa no se confirma (la transacción revierte por completo, incluida la venta) y el pago se vincula automáticamente a esa caja.',
  })
  @ApiCreatedResponse({ type: SaleResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload inválido, sin ítems, producto repetido, cantidad/descuento inválidos, o pago inicial mal formado (monto no positivo o falta la referencia obligatoria del método).',
  })
  @ApiNotFoundResponse({
    description: 'El cliente o algún producto no existe.',
  })
  @ApiConflictResponse({
    description:
      'Cliente/producto/categoría/unidad inactivos, stock insuficiente, el pago inicial supera el total, saldo pendiente positivo con cliente genérico/bloqueado, o (con pago inicial) el actor no tiene ninguna caja abierta o su caja está pendiente de aprobación de un descuadre (Ticket B, Bloque B4).',
  })
  @Roles(...WRITE_ROLES)
  @Post()
  create(
    @Body() dto: CreateSaleDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeSale> {
    return this.salesService.createDirect({
      customerId: dto.customerId,
      discountAmount: dto.discountAmount,
      items: dto.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
      payment: dto.payment
        ? {
            method: dto.payment.method,
            amount: dto.payment.amount,
            reference: dto.payment.reference,
          }
        : undefined,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary:
      'Confirmar una venta a partir de una cotización PENDIENTE o ACEPTADA',
    description:
      'El precio, los ítems y los montos se copian exactamente de la cotización (nunca se repriecian con el catálogo vigente). El producto/categoría/unidad y el stock actual sí se revalidan al confirmar. Cotizaciones RECHAZADAS, VENCIDAS (efectiva o almacenada) o ya CONVERTIDAS no pueden convertirse. Tras el éxito, la cotización queda CONVERTIDA de forma permanente. Admite un cuerpo opcional con un pago inicial (`payment`); sin cuerpo, `{}` y `{ payment: {...} }` son todos válidos. Ticket B, Bloque B4: si se incluye `payment`, el actor autenticado debe tener su propia caja (CashSession) abierta — de lo contrario la conversión completa no se confirma y el pago se vincula automáticamente a esa caja.',
  })
  @ApiParam({ name: 'quoteId', format: 'uuid' })
  @ApiCreatedResponse({ type: SaleResponseDto })
  @ApiBadRequestResponse({
    description:
      'quoteId inválido, o pago inicial mal formado (monto no positivo o falta la referencia obligatoria del método).',
  })
  @ApiNotFoundResponse({
    description: 'La cotización, el cliente o algún producto no existe.',
  })
  @ApiConflictResponse({
    description:
      'Cotización no convertible (rechazada/vencida/ya convertida), ya tiene una venta asociada, entidades inactivas, unidad ya no admite la cantidad histórica, stock insuficiente, el pago inicial supera el total, saldo pendiente positivo con cliente bloqueado, o (con pago inicial) el actor no tiene ninguna caja abierta o su caja está pendiente de aprobación de un descuadre (Ticket B, Bloque B4).',
  })
  @Roles(...WRITE_ROLES)
  @Post('from-quote/:quoteId')
  fromQuote(
    @Param('quoteId', ParseUUIDPipe) quoteId: string,
    @Body() dto: ConvertQuoteToSaleDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeSale> {
    return this.salesService.createFromQuote({
      quoteId,
      payment: dto?.payment
        ? {
            method: dto.payment.method,
            amount: dto.payment.amount,
            reference: dto.payment.reference,
          }
        : undefined,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Listar ventas (paginado, con filtros)',
    description:
      'SELLER tiene acceso Total (sin restricción de propiedad: ve todas las ventas, no solo las propias). El rango confirmedFrom/confirmedTo usa fechas de negocio America/Lima.',
  })
  @ApiOkResponse({ type: PaginatedSalesResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros o rango de fechas inválido.' })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListSalesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeSaleListItem>> {
    return this.salesService.list(query, user.role);
  }

  @ApiOperation({ summary: 'Obtener el detalle de una venta' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SaleResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeSale> {
    return this.salesService.findOne(id, user.role);
  }

  @ApiOperation({
    summary: 'Anular una venta (solo ADMIN)',
    description:
      'Restituye el stock histórico de la venta mediante movimientos de reversa (nunca infiere qué restituir del catálogo vigente). La cotización de origen, si existe, permanece CONVERTIDA de forma permanente: la venta anulada sigue vinculada a ella. El resumen de pago y el estado de entrega quedan congelados con sus valores previos.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SaleResponseDto })
  @ApiBadRequestResponse({
    description: 'Motivo de anulación ausente, vacío o demasiado largo.',
  })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'La venta ya está anulada.' })
  @Roles(...CANCEL_ROLES)
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelSaleDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeSale> {
    return this.salesService.cancel({
      saleId: id,
      reason: dto.reason,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Marcar la venta como entregada',
    description:
      'Transiciones válidas: PENDIENTE→ENTREGADA, OBSERVADA→ENTREGADA. Sin efecto en inventario.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SaleResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'Transición de entrega inválida en el estado actual, o venta anulada.',
  })
  @Roles(...WRITE_ROLES)
  @Post(':id/mark-delivered')
  @HttpCode(HttpStatus.OK)
  markDelivered(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeSale> {
    return this.salesService.markDelivered({
      saleId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Marcar la venta como observada',
    description:
      'Única transición válida: PENDIENTE→OBSERVADA. Sin efecto en inventario.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SaleResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'Transición de entrega inválida en el estado actual, o venta anulada.',
  })
  @Roles(...WRITE_ROLES)
  @Post(':id/mark-observed')
  @HttpCode(HttpStatus.OK)
  markObserved(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeSale> {
    return this.salesService.markObserved({
      saleId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Documento interno imprimible de la venta (HTML, no fiscal)',
    description:
      'HTML simple pensado para imprimir/guardar como PDF desde el navegador, generado en memoria a partir de los snapshots de la venta (nunca datos vivos de Cliente/Producto). Es un documento NO FISCAL (nota de venta interna, sin campos SUNAT). No incluye resumen de pago, movimientos de inventario ni stock. Una venta anulada permanece imprimible con una marca visible ANULADA.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiProduces('text/html')
  @ApiOkResponse({
    description: 'Documento HTML imprimible.',
    content: { 'text/html': { schema: { type: 'string' } } },
  })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id/print')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async print(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<string> {
    const sale = await this.salesService.findOne(id, user.role);
    return this.renderer.render(sale);
  }
}
