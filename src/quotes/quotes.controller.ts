import {
  Body,
  Controller,
  Get,
  Header,
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
import { CreateQuoteDto } from './dto/create-quote.dto';
import { ListQuotesQueryDto } from './dto/list-quotes-query.dto';
import {
  PaginatedQuotesResponseDto,
  QuoteResponseDto,
} from './dto/quote-response.dto';
import { UpdateQuoteDto } from './dto/update-quote.dto';
import { QuoteDocumentRenderer } from './printing/quote-document.renderer';
import { QuotesService } from './quotes.service';
import { SafeQuote, SafeQuoteListItem } from './types/safe-quote';

/** SELLER tiene acceso Total (D9): sin distinción con ADMIN en ninguno de los 7. */
const WRITE_ROLES = [RoleName.ADMIN, RoleName.SELLER] as const;
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.SELLER,
  RoleName.MANAGEMENT,
] as const;

@ApiTags('Quotes')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('quotes')
export class QuotesController {
  constructor(
    private readonly quotesService: QuotesService,
    private readonly renderer: QuoteDocumentRenderer,
  ) {}

  @ApiOperation({
    summary: 'Listar cotizaciones (paginado, con filtros)',
    description:
      'SELLER tiene acceso Total (sin restricción de propiedad: ve todas las cotizaciones, no solo las propias). WAREHOUSE no tiene acceso. El filtro status usa el estado EFECTIVO: EXPIRED se deriva de la fecha de negocio America/Lima y nunca se persiste en la base.',
  })
  @ApiOkResponse({ type: PaginatedQuotesResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros o rango de fechas inválido.' })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListQuotesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeQuoteListItem>> {
    return this.quotesService.list(query, user.role);
  }

  @ApiOperation({ summary: 'Obtener el detalle de una cotización' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: QuoteResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeQuote> {
    return this.quotesService.findOne(id, user.role);
  }

  @ApiOperation({
    summary: 'Crear una cotización (nace PENDIENTE)',
    description:
      'El cliente debe existir, no ser el genérico "Público general" y no estar INACTIVE (BLOCKED sí puede cotizar). El precio de cada ítem se toma siempre de Product.salePrice; el cliente nunca lo controla. La cotización no reserva ni descuenta stock: el stock insuficiente es solo informativo.',
  })
  @ApiCreatedResponse({ type: QuoteResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload inválido, sin ítems, producto repetido, vencimiento anterior a la emisión o descuento mayor al subtotal.',
  })
  @ApiNotFoundResponse({
    description: 'El cliente o algún producto no existe.',
  })
  @ApiConflictResponse({
    description:
      'Cliente genérico/inactivo, o producto/categoría/unidad inactivos.',
  })
  @Roles(...WRITE_ROLES)
  @Post()
  create(
    @Body() dto: CreateQuoteDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeQuote> {
    return this.quotesService.create({
      customerId: dto.customerId,
      expirationDate: dto.expirationDate,
      discountAmount: dto.discountAmount,
      notes: dto.notes,
      items: dto.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Actualizar una cotización pendiente',
    description:
      'Solo una cotización con estado EFECTIVO PENDIENTE es editable. Si se envían items, reemplazan el conjunto completo (mínimo 1) y los precios/snapshots se recalculan desde el catálogo vigente en ese momento.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: QuoteResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload sin campos efectivos, ítems vacíos, producto repetido o descuento mayor al subtotal.',
  })
  @ApiNotFoundResponse({
    description: 'No existe, o algún producto del reemplazo no existe.',
  })
  @ApiConflictResponse({
    description:
      'No está efectivamente PENDIENTE, o producto/categoría/unidad inactivos.',
  })
  @Roles(...WRITE_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateQuoteDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeQuote> {
    return this.quotesService.update({
      quoteId: id,
      expirationDate: dto.expirationDate,
      discountAmount: dto.discountAmount,
      notes: dto.notes,
      items: dto.items?.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Aceptar una cotización pendiente' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: QuoteResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'No está efectivamente PENDIENTE.' })
  @Roles(...WRITE_ROLES)
  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeQuote> {
    return this.quotesService.accept({
      quoteId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Rechazar una cotización pendiente' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: QuoteResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'No está efectivamente PENDIENTE.' })
  @Roles(...WRITE_ROLES)
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeQuote> {
    return this.quotesService.reject({
      quoteId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Documento imprimible de la cotización (HTML)',
    description:
      'HTML simple pensado para imprimir/guardar como PDF desde el navegador, generado en memoria a partir de los snapshots de la cotización (nunca datos vivos de Cliente/Producto). No incluye stockInfo ni información interna. No existe un endpoint de conversión a venta en esta fase.',
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
    const quote = await this.quotesService.findOne(id, user.role);
    return this.renderer.render(quote);
  }
}
