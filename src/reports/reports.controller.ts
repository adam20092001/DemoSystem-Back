import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaginatedResult } from '../common/types/paginated-result';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { PaymentsByMethodQueryDto } from './dto/payments-by-method-query.dto';
import { QuotesByStatusQueryDto } from './dto/quotes-by-status-query.dto';
import {
  PaginatedPaymentsByMethodResponseDto,
  PaginatedQuotesByStatusResponseDto,
  PaginatedSalesByCustomerResponseDto,
  PaginatedSalesByProductResponseDto,
  PaginatedSalesBySellerResponseDto,
} from './dto/report-response.dto';
import { SalesByCustomerQueryDto } from './dto/sales-by-customer-query.dto';
import { SalesByProductQueryDto } from './dto/sales-by-product-query.dto';
import { SalesBySellerQueryDto } from './dto/sales-by-seller-query.dto';
import { ReportsService } from './reports.service';
import {
  PaymentsByMethodRow,
  QuotesByStatusRow,
  SalesByCustomerRow,
  SalesByProductRow,
  SalesBySellerRow,
} from './types/report-results';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.SELLER,
] as const;

/**
 * Reportes operativos de ventas, cobranza y cotizaciones (Fase 9, Bloque
 * B). No sustituye contabilidad formal, PLE/SUNAT ni una plataforma de BI:
 * son 5 vistas agregadas/tabulares de solo lectura sobre datos que ya
 * existen en el sistema (ver Reports en Swagger). Sin exportación, sin
 * porcentajes, sin tablas de reporte propias: cada endpoint consulta las
 * tablas operativas directamente en el momento de la solicitud.
 *
 * Delgado por diseño: cada método valida el rol únicamente vía `@Roles()` +
 * RolesGuard (defensa perimetral) y delega el resto en ReportsService
 * (defensa en profundidad); ningún cálculo ocurre aquí.
 */
@ApiTags('Reports')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este reporte.' })
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @ApiOperation({
    summary: 'R2 — Ventas por producto',
    description:
      'Agrupa SaleItem de ventas ACTIVE (las ventas CANCELLED nunca contribuyen) por producto, dentro del rango de Sale.confirmedAt. La dimensión (SKU, nombre, categoría) es la ACTUAL del catálogo, no el snapshot histórico del ítem: un mismo producto real siempre produce una sola fila agrupada. quantitySold con 3 decimales fijos, totalSold con 2. Orden: totalSold descendente. `total` es la cantidad de productos agrupados que cumplen el filtro, no de filas de venta.',
  })
  @ApiOkResponse({ type: PaginatedSalesByProductResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros o rango de fechas inválido.' })
  @Roles(...READ_ROLES)
  @Get('sales-by-product')
  salesByProduct(
    @Query() query: SalesByProductQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SalesByProductRow>> {
    return this.reportsService.salesByProduct(query, user.role);
  }

  @ApiOperation({
    summary: 'R3 — Ventas por cliente',
    description:
      'Agrupa Sale ACTIVE por cliente (siempre ACTIVE-only, sin parámetro status), dentro del rango de Sale.confirmedAt. totalSold/totalPaid/balance provienen de los campos operativos de Sale, nunca de Payment ni de asientos contables. La dimensión (nombre, documento, tipo) es la ACTUAL del cliente; Público general participa como un grupo normal, sin fila especial. Orden: totalSold descendente. `total` es la cantidad de clientes agrupados, no de ventas.',
  })
  @ApiOkResponse({ type: PaginatedSalesByCustomerResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros o rango de fechas inválido.' })
  @Roles(...READ_ROLES)
  @Get('sales-by-customer')
  salesByCustomer(
    @Query() query: SalesByCustomerQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SalesByCustomerRow>> {
    return this.reportsService.salesByCustomer(query, user.role);
  }

  @ApiOperation({
    summary: 'R4 — Ventas por vendedor',
    description:
      'Agrupa por vendedor el cohorte de Sale ACTIVE con confirmedAt en rango (saleCount, totalSold). totalCollected suma Payment ACTIVE cuyo saleId pertenece a ese cohorte, SIN filtrar por Payment.paidAt: un cobro fuera del rango del reporte igual cuenta si su venta está en el cohorte. convertedQuotes cuenta Quote con status=CONVERTED cuyo issueDate cae en el MISMO rango, de forma independiente (no depende de si la venta resultante sigue activa; sin porcentaje de conversión). Ambos pueden ser "0.00"/0 sin que el vendedor desaparezca del listado. Orden: totalSold descendente.',
  })
  @ApiOkResponse({ type: PaginatedSalesBySellerResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros o rango de fechas inválido.' })
  @Roles(...READ_ROLES)
  @Get('sales-by-seller')
  salesBySeller(
    @Query() query: SalesBySellerQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SalesBySellerRow>> {
    return this.reportsService.salesBySeller(query, user.role);
  }

  @ApiOperation({
    summary: 'R8 — Cotizaciones por estado',
    description:
      'Listado tabular (una fila por cotización): todos los estados son visibles, sin exclusión implícita. customerName es el snapshot guardado en la propia cotización, nunca una relectura del cliente vigente. `from`/`to` filtran Quote.issueDate (límites inclusivos). resultingSale referencia la venta generada por la conversión y permanece visible aunque esa venta haya sido anulada después. Orden: issueDate descendente. Sin agregación: `total` es la cantidad de cotizaciones que cumplen el filtro.',
  })
  @ApiOkResponse({ type: PaginatedQuotesByStatusResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros o rango de fechas inválido.' })
  @Roles(...READ_ROLES)
  @Get('quotes-by-status')
  quotesByStatus(
    @Query() query: QuotesByStatusQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<QuotesByStatusRow>> {
    return this.reportsService.quotesByStatus(query, user.role);
  }

  @ApiOperation({
    summary: 'R9 — Pagos por método',
    description:
      'Listado tabular (una fila por pago), pese al nombre de la ruta: no agrupa por método. Todos los estados de Payment son visibles por defecto (ACTIVE y CANCELLED): la exclusión de pagos anulados es una regla de agregados, no de este listado histórico. `from`/`to` filtran Payment.paidAt. saleNumber/customerName vienen del snapshot de la venta asociada; reference se expone tal cual. Orden: paidAt descendente. Sin agregación: `total` es la cantidad de pagos que cumplen el filtro.',
  })
  @ApiOkResponse({ type: PaginatedPaymentsByMethodResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros o rango de fechas inválido.' })
  @Roles(...READ_ROLES)
  @Get('payments-by-method')
  paymentsByMethod(
    @Query() query: PaymentsByMethodQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<PaymentsByMethodRow>> {
    return this.reportsService.paymentsByMethod(query, user.role);
  }
}
