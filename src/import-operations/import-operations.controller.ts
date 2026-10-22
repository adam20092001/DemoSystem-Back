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
import { CancelImportOperationDto } from './dto/cancel-import-operation.dto';
import { CreateImportOperationDto } from './dto/create-import-operation.dto';
import { CreateImportShipmentDto } from './dto/create-import-shipment.dto';
import {
  ImportOperationResponseDto,
  PaginatedImportOperationsResponseDto,
} from './dto/import-operation-response.dto';
import {
  ImportShipmentResponseDto,
  PaginatedImportShipmentsResponseDto,
} from './dto/import-shipment-response.dto';
import { ListImportOperationsQueryDto } from './dto/list-import-operations-query.dto';
import { UpdateImportOperationDto } from './dto/update-import-operation.dto';
import { ImportOperationsService } from './import-operations.service';
import { ImportShipmentsService } from './import-shipments.service';
import { SafeImportOperation } from './types/safe-import-operation';
import { SafeImportShipment } from './types/safe-import-shipment';

const WRITE_ROLES = [RoleName.ADMIN] as const;
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;

/**
 * Operaciones de importación (Fase B1) — expediente logístico genérico,
 * reutilizable por cualquier industria. ADMIN administra el ciclo de vida
 * completo; MANAGEMENT/ACCOUNTANT solo leen; SELLER/WAREHOUSE sin ningún
 * acceso (CLAUDE.md B1 §6). Ningún endpoint de este controller mueve
 * inventario ni genera efecto contable — ver ImportOperationsService/
 * ImportShipmentsService para el alcance exacto.
 */
@ApiTags('Import Operations')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('import-operations')
export class ImportOperationsController {
  constructor(
    private readonly importOperationsService: ImportOperationsService,
    private readonly importShipmentsService: ImportShipmentsService,
  ) {}

  @ApiOperation({
    summary: 'Listar operaciones de importación (paginado, con filtros)',
  })
  @ApiOkResponse({ type: PaginatedImportOperationsResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListImportOperationsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeImportOperation>> {
    return this.importOperationsService.list(query, user.role);
  }

  @ApiOperation({
    summary: 'Obtener el detalle de una operación de importación',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportOperationResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeImportOperation> {
    return this.importOperationsService.findOne(id, user.role);
  }

  @ApiOperation({
    summary: 'Crear una operación de importación (solo ADMIN; nace DRAFT)',
    description:
      'Deliberadamente sin supplierId/purchaseInvoiceId propio: una importación consolidada puede abarcar varios proveedores/facturas, asociados únicamente a nivel de línea de embarque.',
  })
  @ApiCreatedResponse({ type: ImportOperationResponseDto })
  @ApiBadRequestResponse({ description: 'Payload inválido.' })
  @ApiConflictResponse({
    description: 'Ya existe una operación con la misma reference.',
  })
  @Roles(...WRITE_ROLES)
  @Post()
  create(
    @Body() dto: CreateImportOperationDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportOperation> {
    return this.importOperationsService.create({
      reference: dto.reference,
      description: dto.description,
      originCountry: dto.originCountry,
      destinationCountry: dto.destinationCountry,
      externalReference: dto.externalReference,
      notes: dto.notes,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Actualizar una operación de importación (solo ADMIN)',
    description:
      'reference y status son inmutables aquí. Bloqueado si la operación ya es COMPLETED o CANCELLED.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportOperationResponseDto })
  @ApiBadRequestResponse({ description: 'Payload vacío o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'La operación ya es COMPLETED o CANCELLED.',
  })
  @Roles(...WRITE_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateImportOperationDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportOperation> {
    return this.importOperationsService.update({
      importOperationId: id,
      description: dto.description,
      originCountry: dto.originCountry,
      destinationCountry: dto.destinationCountry,
      externalReference: dto.externalReference,
      notes: dto.notes,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Completar operativamente una operación IN_PROGRESS (solo ADMIN)',
    description:
      'Cierre OPERATIVO/logístico, nunca financiero/contable. Exige que ningún embarque esté todavía PLANNED/IN_TRANSIT.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportOperationResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'La operación no está IN_PROGRESS, o tiene embarques PLANNED/IN_TRANSIT.',
  })
  @Roles(...WRITE_ROLES)
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportOperation> {
    return this.importOperationsService.complete({
      importOperationId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Anular una operación DRAFT o IN_PROGRESS (solo ADMIN)',
    description: 'Bloqueada si algún embarque ya está ARRIVED.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportOperationResponseDto })
  @ApiBadRequestResponse({ description: 'reason faltante o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'La operación no está DRAFT/IN_PROGRESS, o tiene un embarque ARRIVED.',
  })
  @Roles(...WRITE_ROLES)
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelImportOperationDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportOperation> {
    return this.importOperationsService.cancel({
      importOperationId: id,
      reason: dto.reason,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Listar los embarques de una operación de importación',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PaginatedImportShipmentsResponseDto })
  @ApiNotFoundResponse({ description: 'La operación no existe.' })
  @Roles(...READ_ROLES)
  @Get(':id/shipments')
  listShipments(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeImportShipment>> {
    return this.importShipmentsService.listByOperation(id, user.role);
  }

  @ApiOperation({
    summary:
      'Registrar un embarque bajo una operación de importación (solo ADMIN)',
    description:
      'Nunca mueve inventario ni genera efecto contable. El vínculo opcional a una PurchaseInvoiceLine CONFIRMED se protege contra sobre-asignación (incluida concurrencia real) bajo lock transaccional. Transiciona automáticamente la operación DRAFT->IN_PROGRESS.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: ImportShipmentResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload inválido, producto/línea de factura inexistente, o inconsistencia de producto.',
  })
  @ApiNotFoundResponse({ description: 'La operación no existe.' })
  @ApiConflictResponse({
    description:
      'La operación está COMPLETED/CANCELLED, la línea de factura referenciada no está CONFIRMED, o la cantidad planificada excede lo facturado.',
  })
  @Roles(...WRITE_ROLES)
  @Post(':id/shipments')
  createShipment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateImportShipmentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportShipment> {
    return this.importShipmentsService.create({
      importOperationId: id,
      transportMode: dto.transportMode,
      carrierName: dto.carrierName,
      trackingReference: dto.trackingReference,
      billOfLadingNumber: dto.billOfLadingNumber,
      containerReference: dto.containerReference,
      originLocation: dto.originLocation,
      destinationLocation: dto.destinationLocation,
      estimatedDepartureDate: dto.estimatedDepartureDate,
      estimatedArrivalDate: dto.estimatedArrivalDate,
      notes: dto.notes,
      lines: dto.lines,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
