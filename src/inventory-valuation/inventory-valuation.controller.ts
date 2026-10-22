import { Controller, Get, Query } from '@nestjs/common';
import {
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
import { ListPendingValuationQueryDto } from './dto/list-pending-valuation-query.dto';
import { ListValuedInventoryQueryDto } from './dto/list-valued-inventory-query.dto';
import {
  PaginatedPendingValuationResponseDto,
  PaginatedValuedInventoryResponseDto,
} from './dto/valued-inventory-response.dto';
import { InventoryValuationService } from './inventory-valuation.service';
import {
  PendingValuationItem,
  ValuedInventoryItem,
} from './types/valued-inventory-item';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;

/**
 * Existencias valorizadas de inventario (Fase A6.1): solo lectura. Nunca
 * accesible a SELLER/WAREHOUSE (expone costo) — ver
 * InventoryValuationService para el detalle de la decisión.
 */
@ApiTags('Inventory Valuation')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('inventory/valuation')
export class InventoryValuationController {
  constructor(
    private readonly inventoryValuationService: InventoryValuationService,
  ) {}

  @ApiOperation({
    summary: 'Existencias valorizadas por producto (paginado)',
    description:
      'Solo productos con valuationMethod configurado. valuedQuantity/weightedAverageUnitCost/totalValue se calculan siempre en tiempo de lectura a partir del historial inmutable de InventoryValuation — nunca una columna duplicada. physicalStockCurrent es solo referencia (Product.stockCurrent); puede diferir de valuedQuantity a propósito. LIMITACIÓN EXPLÍCITA DE A6.1: ninguna venta resta valorización todavía (COGS/consumo por venta es A6.2, no implementada) — totalValue/valuedQuantity NUNCA deben leerse como el valor contable completo o vigente del stock en almacén cuando ya existieron salidas por venta no valorizadas; son únicamente el acumulado capitalizado por recepciones.',
  })
  @ApiOkResponse({ type: PaginatedValuedInventoryResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  getValuedInventory(
    @Query() query: ListValuedInventoryQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<ValuedInventoryItem>> {
    return this.inventoryValuationService.getValuedInventory(query, user.role);
  }

  @ApiOperation({
    summary: 'Movimientos de recepción todavía sin valorizar (paginado)',
    description:
      'Entradas ENTRY por recepción de compra de un producto con valorización habilitada que todavía no generaron un evento InventoryValuation (p. ej. línea sin monto elegible, o la valorización se habilitó después de recibir).',
  })
  @ApiOkResponse({ type: PaginatedPendingValuationResponseDto })
  @Roles(...READ_ROLES)
  @Get('pending')
  getPendingValuation(
    @Query() query: ListPendingValuationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<PendingValuationItem>> {
    return this.inventoryValuationService.getPendingValuation(query, user.role);
  }
}
