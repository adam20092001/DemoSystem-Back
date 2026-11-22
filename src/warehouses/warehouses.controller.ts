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
import {
  PaginatedWarehouseLocationsResponseDto,
  PaginatedWarehousesResponseDto,
  WarehouseLocationResponseDto,
  WarehouseResponseDto,
} from './dto/warehouse-response.dto';
import {
  CreateWarehouseDto,
  CreateWarehouseLocationDto,
  ListWarehouseLocationsQueryDto,
  ListWarehousesQueryDto,
  UpdateWarehouseDto,
  UpdateWarehouseLocationDto,
} from './dto/warehouse-request.dto';
import { SafeWarehouse, SafeWarehouseLocation } from './types/warehouse.types';
import { WarehouseLocationsService } from './warehouse-locations.service';
import { WarehousesService } from './warehouses.service';

/**
 * R2-A1: ADMIN administra el catálogo; ADMIN, WAREHOUSE, MANAGEMENT y SELLER
 * lo leen. PURCHASING y ACCOUNTANT reciben 403 en todo.
 */
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
  RoleName.SELLER,
] as const;
const MANAGE_ROLES = [RoleName.ADMIN] as const;

/**
 * Catálogo de almacenes y ubicaciones (R2-A1). Ningún endpoint de este
 * controlador mueve stock, y el frontend NO debe usarlo todavía para operar
 * existencias (la selección de ubicación en operaciones es R2-B; R2-ACT no
 * cambia este contrato). Las ubicaciones viven bajo su almacén:
 * una ubicación de otro almacén responde 404.
 */
@ApiTags('Warehouses')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('warehouses')
export class WarehousesController {
  constructor(
    private readonly warehousesService: WarehousesService,
    private readonly locationsService: WarehouseLocationsService,
  ) {}

  // --- Almacenes ------------------------------------------------------------

  @ApiOperation({ summary: 'Listar almacenes (paginado, con filtros)' })
  @ApiOkResponse({ type: PaginatedWarehousesResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListWarehousesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeWarehouse>> {
    return this.warehousesService.list(query, user.role);
  }

  @ApiOperation({ summary: 'Obtener el detalle de un almacén' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: WarehouseResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeWarehouse> {
    return this.warehousesService.findOne(id, user.role);
  }

  @ApiOperation({
    summary: 'Crear un almacén (solo ADMIN; nace ACTIVE)',
    description:
      'Crea también su ubicación técnica DEFAULT en la misma transacción. No crea ni mueve stock.',
  })
  @ApiCreatedResponse({ type: WarehouseResponseDto })
  @ApiBadRequestResponse({ description: 'Payload o código inválido.' })
  @ApiConflictResponse({ description: 'Ya existe un almacén con ese código.' })
  @Roles(...MANAGE_ROLES)
  @Post()
  create(
    @Body() dto: CreateWarehouseDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeWarehouse> {
    return this.warehousesService.create({
      code: dto.code,
      name: dto.name,
      description: dto.description,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Editar nombre y descripción de un almacén (solo ADMIN)',
    description:
      'code, status e isDefault son inmutables: enviarlos produce 400. El estado cambia solo con activate/deactivate.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: WarehouseResponseDto })
  @ApiBadRequestResponse({ description: 'Payload vacío o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...MANAGE_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarehouseDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeWarehouse> {
    return this.warehousesService.update({
      warehouseId: id,
      name: dto.name,
      description: dto.description,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Activar un almacén (solo ADMIN)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: WarehouseResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'Ya estaba ACTIVE.' })
  @Roles(...MANAGE_ROLES)
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeWarehouse> {
    return this.warehousesService.activate({
      warehouseId: id,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Desactivar un almacén (solo ADMIN)',
    description:
      'Bloqueado (409) para el almacén principal, si ya estaba INACTIVE, o si cualquiera de sus ubicaciones tiene saldos, movimientos o líneas asociadas. Durante EXPAND no puede demostrarse stock cero, así que ante cualquier rastro se bloquea.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: WarehouseResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'Principal, ya inactivo o con dependencias.',
  })
  @Roles(...MANAGE_ROLES)
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeWarehouse> {
    return this.warehousesService.deactivate({
      warehouseId: id,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  // --- Ubicaciones (siempre bajo su almacén) --------------------------------

  @ApiOperation({ summary: 'Listar las ubicaciones de un almacén' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiOkResponse({ type: PaginatedWarehouseLocationsResponseDto })
  @ApiNotFoundResponse({ description: 'El almacén no existe.' })
  @Roles(...READ_ROLES)
  @Get(':warehouseId/locations')
  listLocations(
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Query() query: ListWarehouseLocationsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeWarehouseLocation>> {
    return this.locationsService.list(warehouseId, query, user.role);
  }

  @ApiOperation({ summary: 'Obtener una ubicación de un almacén' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'locationId', format: 'uuid' })
  @ApiOkResponse({ type: WarehouseLocationResponseDto })
  @ApiNotFoundResponse({
    description: 'No existe, o pertenece a otro almacén.',
  })
  @Roles(...READ_ROLES)
  @Get(':warehouseId/locations/:locationId')
  findLocation(
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeWarehouseLocation> {
    return this.locationsService.findOne(warehouseId, locationId, user.role);
  }

  @ApiOperation({
    summary: 'Crear una ubicación en un almacén (solo ADMIN; nace ACTIVE)',
    description:
      'El almacén debe existir y estar ACTIVE. El código DEFAULT está reservado.',
  })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiCreatedResponse({ type: WarehouseLocationResponseDto })
  @ApiBadRequestResponse({ description: 'Payload o código inválido.' })
  @ApiNotFoundResponse({ description: 'El almacén no existe.' })
  @ApiConflictResponse({
    description:
      'Código duplicado en el almacén, reservado (DEFAULT) o almacén inactivo.',
  })
  @Roles(...MANAGE_ROLES)
  @Post(':warehouseId/locations')
  createLocation(
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Body() dto: CreateWarehouseLocationDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeWarehouseLocation> {
    return this.locationsService.create({
      warehouseId,
      code: dto.code,
      name: dto.name,
      description: dto.description,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Editar nombre y descripción de una ubicación (solo ADMIN)',
    description:
      'code, status e isDefault son inmutables: enviarlos produce 400.',
  })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'locationId', format: 'uuid' })
  @ApiOkResponse({ type: WarehouseLocationResponseDto })
  @ApiBadRequestResponse({ description: 'Payload vacío o inválido.' })
  @ApiNotFoundResponse({
    description: 'No existe, o pertenece a otro almacén.',
  })
  @Roles(...MANAGE_ROLES)
  @Patch(':warehouseId/locations/:locationId')
  updateLocation(
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Body() dto: UpdateWarehouseLocationDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeWarehouseLocation> {
    return this.locationsService.update({
      warehouseId,
      locationId,
      name: dto.name,
      description: dto.description,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Activar una ubicación (solo ADMIN)',
    description: 'Su almacén debe estar ACTIVE.',
  })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'locationId', format: 'uuid' })
  @ApiOkResponse({ type: WarehouseLocationResponseDto })
  @ApiNotFoundResponse({
    description: 'No existe, o pertenece a otro almacén.',
  })
  @ApiConflictResponse({ description: 'Ya activa, o almacén inactivo.' })
  @Roles(...MANAGE_ROLES)
  @Post(':warehouseId/locations/:locationId/activate')
  @HttpCode(HttpStatus.OK)
  activateLocation(
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeWarehouseLocation> {
    return this.locationsService.activate({
      warehouseId,
      locationId,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Desactivar una ubicación (solo ADMIN)',
    description:
      'Bloqueado (409) para la ubicación DEFAULT, si ya estaba INACTIVE, o si tiene saldos, movimientos o líneas asociadas (durante EXPAND no puede demostrarse stock cero).',
  })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'locationId', format: 'uuid' })
  @ApiOkResponse({ type: WarehouseLocationResponseDto })
  @ApiNotFoundResponse({
    description: 'No existe, o pertenece a otro almacén.',
  })
  @ApiConflictResponse({
    description: 'DEFAULT, ya inactiva o con dependencias.',
  })
  @Roles(...MANAGE_ROLES)
  @Post(':warehouseId/locations/:locationId/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivateLocation(
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeWarehouseLocation> {
    return this.locationsService.deactivate({
      warehouseId,
      locationId,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
