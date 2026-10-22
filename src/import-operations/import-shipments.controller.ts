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
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { ArriveImportShipmentDto } from './dto/arrive-import-shipment.dto';
import { CancelImportShipmentDto } from './dto/cancel-import-shipment.dto';
import { DepartImportShipmentDto } from './dto/depart-import-shipment.dto';
import { ImportShipmentResponseDto } from './dto/import-shipment-response.dto';
import { UpdateImportShipmentDto } from './dto/update-import-shipment.dto';
import { ImportShipmentsService } from './import-shipments.service';
import { SafeImportShipment } from './types/safe-import-shipment';

const WRITE_ROLES = [RoleName.ADMIN] as const;
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;

/** Consulta de detalle, edición mientras PLANNED, y transiciones explícitas de UN embarque, por su propio id (Fase B1). */
@ApiTags('Import Operations')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('import-shipments')
export class ImportShipmentsController {
  constructor(
    private readonly importShipmentsService: ImportShipmentsService,
  ) {}

  @ApiOperation({ summary: 'Obtener el detalle de un embarque de importación' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportShipmentResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeImportShipment> {
    return this.importShipmentsService.findOne(id, user.role);
  }

  @ApiOperation({
    summary: 'Editar un embarque mientras está PLANNED (solo ADMIN)',
    description:
      '`lines`, si se provee, reemplaza el arreglo completo. Rechazado (409) en cualquier estado distinto de PLANNED.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportShipmentResponseDto })
  @ApiBadRequestResponse({ description: 'Payload vacío o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'El embarque no está PLANNED, o la nueva asignación excede lo facturado.',
  })
  @Roles(...WRITE_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateImportShipmentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportShipment> {
    return this.importShipmentsService.update({
      importShipmentId: id,
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

  @ApiOperation({
    summary: 'Marcar un embarque PLANNED en tránsito (solo ADMIN)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportShipmentResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'El embarque no está PLANNED.' })
  @Roles(...WRITE_ROLES)
  @Post(':id/depart')
  @HttpCode(HttpStatus.OK)
  depart(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DepartImportShipmentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportShipment> {
    return this.importShipmentsService.depart({
      importShipmentId: id,
      actualDepartureDate: dto.actualDepartureDate,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Marcar un embarque como llegado a destino logístico (solo ADMIN)',
    description:
      'ARRIVED es un hecho LOGÍSTICO, nunca una recepción física de inventario — no mueve stock. Permitido desde PLANNED o IN_TRANSIT.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportShipmentResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'El embarque no está PLANNED ni IN_TRANSIT.',
  })
  @Roles(...WRITE_ROLES)
  @Post(':id/arrive')
  @HttpCode(HttpStatus.OK)
  arrive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ArriveImportShipmentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportShipment> {
    return this.importShipmentsService.arrive({
      importShipmentId: id,
      actualArrivalDate: dto.actualArrivalDate,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Anular un embarque PLANNED o IN_TRANSIT (solo ADMIN)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportShipmentResponseDto })
  @ApiBadRequestResponse({ description: 'reason faltante o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'El embarque no está PLANNED ni IN_TRANSIT.',
  })
  @Roles(...WRITE_ROLES)
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelImportShipmentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportShipment> {
    return this.importShipmentsService.cancel({
      importShipmentId: id,
      reason: dto.reason,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
