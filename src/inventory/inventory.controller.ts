import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { ListLowStockQueryDto } from './dto/list-low-stock-query.dto';
import { ListMovementsQueryDto } from './dto/list-movements-query.dto';
import {
  MovementResponseDto,
  PaginatedMovementsResponseDto,
} from './dto/movement-response.dto';
import { PaginatedLowStockResponseDto } from './dto/low-stock-item-response.dto';
import { ProductStockResponseDto } from './dto/product-stock-response.dto';
import { RegisterAdjustmentInDto } from './dto/register-adjustment-in.dto';
import { RegisterAdjustmentOutDto } from './dto/register-adjustment-out.dto';
import { RegisterEntryDto } from './dto/register-entry.dto';
import { RegisterExitDto } from './dto/register-exit.dto';
import { RegisterInitialBalanceDto } from './dto/register-initial-balance.dto';
import { InventoryService } from './inventory.service';
import { ListMovementsQuery } from './types/list-movements.query';
import { RegisterMovementInput } from './types/register-movement.input';
import { SafeInventoryMovement } from './types/safe-inventory-movement';
import { SafeLowStockItem, SafeProductStock } from './types/safe-product-stock';

const WRITE_ROLES = [RoleName.ADMIN, RoleName.WAREHOUSE] as const;
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
] as const;
const STOCK_READ_ROLES = [
  RoleName.ADMIN,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
  RoleName.SELLER,
] as const;

@ApiTags('Inventory')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @ApiOperation({
    summary: 'Registrar el saldo inicial de un producto',
    description:
      'Solo válido cuando el producto tiene stockCurrent="0.000" y no registra movimientos previos.',
  })
  @ApiCreatedResponse({ type: MovementResponseDto })
  @ApiBadRequestResponse({ description: 'Payload inválido.' })
  @ApiNotFoundResponse({ description: 'El producto no existe.' })
  @ApiConflictResponse({
    description:
      'El producto ya tiene stock distinto de cero, o ya registra movimientos.',
  })
  @Roles(...WRITE_ROLES)
  @Post('initial-balances')
  registerInitialBalance(
    @Body() dto: RegisterInitialBalanceDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeInventoryMovement> {
    return this.inventoryService.registerInitialBalance(
      this.toRegisterMovementInput(dto, actor, request),
    );
  }

  @ApiOperation({ summary: 'Registrar una entrada manual de stock' })
  @ApiCreatedResponse({ type: MovementResponseDto })
  @ApiBadRequestResponse({ description: 'Payload inválido.' })
  @ApiNotFoundResponse({ description: 'El producto no existe.' })
  @ApiConflictResponse({
    description: 'El producto/categoría/unidad no está activo.',
  })
  @Roles(...WRITE_ROLES)
  @Post('entries')
  registerEntry(
    @Body() dto: RegisterEntryDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeInventoryMovement> {
    return this.inventoryService.registerEntry(
      this.toRegisterMovementInput(dto, actor, request),
    );
  }

  @ApiOperation({ summary: 'Registrar una salida manual de stock' })
  @ApiCreatedResponse({ type: MovementResponseDto })
  @ApiBadRequestResponse({ description: 'Payload inválido.' })
  @ApiNotFoundResponse({ description: 'El producto no existe.' })
  @ApiConflictResponse({
    description: 'Stock insuficiente, o producto/categoría/unidad inactivo.',
  })
  @Roles(...WRITE_ROLES)
  @Post('exits')
  registerExit(
    @Body() dto: RegisterExitDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeInventoryMovement> {
    return this.inventoryService.registerExit(
      this.toRegisterMovementInput(dto, actor, request),
    );
  }

  @ApiOperation({ summary: 'Registrar un ajuste positivo de stock' })
  @ApiCreatedResponse({ type: MovementResponseDto })
  @ApiBadRequestResponse({ description: 'Payload inválido.' })
  @ApiNotFoundResponse({ description: 'El producto no existe.' })
  @ApiConflictResponse({
    description: 'El producto/categoría/unidad no está activo.',
  })
  @Roles(...WRITE_ROLES)
  @Post('adjustments/in')
  registerPositiveAdjustment(
    @Body() dto: RegisterAdjustmentInDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeInventoryMovement> {
    return this.inventoryService.registerPositiveAdjustment(
      this.toRegisterMovementInput(dto, actor, request),
    );
  }

  @ApiOperation({ summary: 'Registrar un ajuste negativo de stock' })
  @ApiCreatedResponse({ type: MovementResponseDto })
  @ApiBadRequestResponse({ description: 'Payload inválido.' })
  @ApiNotFoundResponse({ description: 'El producto no existe.' })
  @ApiConflictResponse({
    description: 'Stock insuficiente, o producto/categoría/unidad inactivo.',
  })
  @Roles(...WRITE_ROLES)
  @Post('adjustments/out')
  registerNegativeAdjustment(
    @Body() dto: RegisterAdjustmentOutDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeInventoryMovement> {
    return this.inventoryService.registerNegativeAdjustment(
      this.toRegisterMovementInput(dto, actor, request),
    );
  }

  @ApiOperation({
    summary: 'Listar movimientos de inventario (kardex global, paginado)',
  })
  @ApiOkResponse({ type: PaginatedMovementsResponseDto })
  @ApiBadRequestResponse({ description: 'dateFrom mayor que dateTo.' })
  @Roles(...READ_ROLES)
  @Get('movements')
  listMovements(
    @Query() query: ListMovementsQueryDto,
  ): Promise<PaginatedResult<SafeInventoryMovement>> {
    return this.inventoryService.listMovements(this.toMovementsQuery(query));
  }

  @ApiOperation({ summary: 'Obtener un movimiento de inventario por id' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: MovementResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get('movements/:id')
  findMovementById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SafeInventoryMovement> {
    return this.inventoryService.findMovementById(id);
  }

  @ApiOperation({
    summary: 'Listar el kardex de un producto (histórico, paginado)',
    description:
      'Visible aunque el producto/categoría/unidad esté inactivo: es un registro histórico.',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiOkResponse({ type: PaginatedMovementsResponseDto })
  @ApiNotFoundResponse({ description: 'El producto no existe.' })
  @Roles(...READ_ROLES)
  @Get('products/:productId/movements')
  async listProductMovements(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Query() query: ListMovementsQueryDto,
  ): Promise<PaginatedResult<SafeInventoryMovement>> {
    if (query.productId !== undefined && query.productId !== productId) {
      throw new BadRequestException(
        'El productId del query no puede contradecir el de la ruta',
      );
    }
    return this.inventoryService.listProductMovements(
      productId,
      this.toMovementsQuery(query),
    );
  }

  @ApiOperation({
    summary: 'Consultar el stock actual de un producto',
    description:
      'SELLER solo puede consultar productos con producto/categoría/unidad ACTIVE (404 en cualquier otro caso, sin revelar cuál está inactivo).',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiOkResponse({ type: ProductStockResponseDto })
  @ApiBadRequestResponse({
    description: 'El producto es SERVICE o no controla inventario.',
  })
  @ApiNotFoundResponse({ description: 'No existe, o SELLER sin acceso.' })
  @Roles(...STOCK_READ_ROLES)
  @Get('products/:productId/stock')
  getProductStock(
    @Param('productId', ParseUUIDPipe) productId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeProductStock> {
    return this.inventoryService.getProductStock(productId, user.role);
  }

  @ApiOperation({
    summary: 'Listar productos con stock bajo (paginado)',
    description: 'stockCurrent <= stockMinimum, con categoría y unidad ACTIVE.',
  })
  @ApiOkResponse({ type: PaginatedLowStockResponseDto })
  @Roles(...READ_ROLES)
  @Get('low-stock')
  listLowStock(
    @Query() query: ListLowStockQueryDto,
  ): Promise<PaginatedResult<SafeLowStockItem>> {
    return this.inventoryService.listLowStock({
      page: query.page,
      limit: query.limit,
      categoryId: query.categoryId,
      unitId: query.unitId,
      search: query.search,
      brand: query.brand,
      status: query.status,
    });
  }

  private toRegisterMovementInput(
    dto: {
      productId: string;
      quantity: string;
      reason: string;
      notes?: string;
    },
    actor: AuthenticatedUser,
    request: Request,
  ): RegisterMovementInput {
    return {
      productId: dto.productId,
      quantity: dto.quantity,
      reason: dto.reason,
      notes: dto.notes ?? null,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    };
  }

  private toMovementsQuery(dto: ListMovementsQueryDto): ListMovementsQuery {
    return {
      page: dto.page,
      limit: dto.limit,
      productId: dto.productId,
      movementType: dto.movementType,
      origin: dto.origin,
      createdByUserId: dto.createdByUserId,
      dateFrom: dto.dateFrom !== undefined ? new Date(dto.dateFrom) : undefined,
      dateTo: dto.dateTo !== undefined ? new Date(dto.dateTo) : undefined,
      search: dto.search,
    };
  }
}
