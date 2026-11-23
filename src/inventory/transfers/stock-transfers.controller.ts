import {
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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PaginatedResult } from '../../common/types/paginated-result';
import { COOKIE_AUTH_NAME } from '../../config/swagger';
import { CreateStockTransferDto } from './dto/create-stock-transfer.dto';
import { ListStockTransfersQueryDto } from './dto/list-stock-transfers-query.dto';
import {
  PaginatedStockTransfersResponseDto,
  StockTransferResponseDto,
} from './dto/stock-transfer-response.dto';
import { StockTransfersService } from './stock-transfers.service';
import { ListStockTransfersQuery } from './types/create-stock-transfer.input';
import { SafeStockTransfer } from './types/safe-stock-transfer';

/** Misma política que los movimientos manuales: crean ADMIN/WAREHOUSE; leen además MANAGEMENT. */
const WRITE_ROLES = [RoleName.ADMIN, RoleName.WAREHOUSE] as const;
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
] as const;

@ApiTags('Inventory')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('inventory/transfers')
export class StockTransfersController {
  constructor(private readonly transfersService: StockTransfersService) {}

  @ApiOperation({
    summary: 'Transferir stock de un producto entre dos ubicaciones',
    description:
      'R2-C. Un producto por transferencia: EXIT en la ubicación de origen y ENTRY en la de destino, en UNA transacción (misma o distinta almacén). El stock consolidado del producto no cambia. El origen debe tener saldo propio suficiente; nunca se completa con otras ubicaciones. La transferencia es INMUTABLE (no se anula): una corrección es otra transferencia en sentido inverso. No genera valorización, COGS ni asientos contables. `idempotencyKey` es opcional: misma clave + mismo usuario + mismo contenido devuelve la transferencia original; contenido distinto responde 409; sin clave no hay deduplicación.',
  })
  @ApiCreatedResponse({ type: StockTransferResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload inválido, UUID mal formado, origen igual a destino, cantidad no positiva o con más de 3 decimales.',
  })
  @ApiNotFoundResponse({
    description: 'El producto o alguna ubicación no existe.',
  })
  @ApiConflictResponse({
    description:
      'Ubicación o almacén inactivos, producto inactivo o no inventariable, stock insuficiente en el origen, o clave de idempotencia reutilizada con otro contenido.',
  })
  @Roles(...WRITE_ROLES)
  @Post()
  create(
    @Body() dto: CreateStockTransferDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeStockTransfer> {
    return this.transfersService.create({
      productId: dto.productId,
      sourceLocationId: dto.sourceLocationId,
      destinationLocationId: dto.destinationLocationId,
      quantity: dto.quantity,
      reason: dto.reason,
      notes: dto.notes,
      idempotencyKey: dto.idempotencyKey,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Listar transferencias de stock (paginado, con filtros)',
  })
  @ApiOkResponse({ type: PaginatedStockTransfersResponseDto })
  @ApiBadRequestResponse({ description: 'dateFrom mayor que dateTo.' })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListStockTransfersQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeStockTransfer>> {
    return this.transfersService.list(this.toQuery(query), actor.role);
  }

  @ApiOperation({ summary: 'Obtener una transferencia de stock por id' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: StockTransferResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<SafeStockTransfer> {
    return this.transfersService.findOne(id, actor.role);
  }

  private toQuery(dto: ListStockTransfersQueryDto): ListStockTransfersQuery {
    return {
      page: dto.page,
      limit: dto.limit,
      productId: dto.productId,
      sourceLocationId: dto.sourceLocationId,
      destinationLocationId: dto.destinationLocationId,
      warehouseId: dto.warehouseId,
      dateFrom: dto.dateFrom !== undefined ? new Date(dto.dateFrom) : undefined,
      dateTo: dto.dateTo !== undefined ? new Date(dto.dateTo) : undefined,
    };
  }
}
