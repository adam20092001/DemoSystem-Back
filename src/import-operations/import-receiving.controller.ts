import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
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
import {
  LinkExistingReceiptsDto,
  ReceiveFromImportDto,
} from './dto/import-receiving.dto';
import { ImportReceivingService } from './import-receiving.service';
import {
  ImportReceivingResult,
  ImportReceivingSummary,
} from './types/import-receiving.types';

const WRITE_ROLES = [RoleName.ADMIN, RoleName.PURCHASING] as const;
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
  RoleName.PURCHASING,
] as const;

/**
 * Recepción de mercadería desde Importaciones (R5). Reutiliza la recepción de
 * compra existente: cada operación de escritura es atómica (todo o nada) y exige
 * la cabecera Idempotency-Key. Marcar un embarque ARRIVED o completar la
 * operación nunca mueve stock por sí mismo.
 */
@ApiTags('Import Receiving')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('import-operations/:importOperationId')
export class ImportReceivingController {
  constructor(private readonly service: ImportReceivingService) {}

  @ApiOperation({
    summary: 'Cantidades y pendientes de recepción de una importación',
    description:
      'Por línea de embarque: facturado, asignado a embarques, recibido, embarcado, vinculado y pendiente de ESTA importación, más las líneas de recepción ya registradas que pueden vincularse. No incluye importes.',
  })
  @ApiParam({ name: 'importOperationId', format: 'uuid' })
  @ApiOkResponse({
    description: 'Resumen de recepción (ImportReceivingSummary).',
  })
  @ApiNotFoundResponse({ description: 'La operación no existe.' })
  @Roles(...READ_ROLES)
  @Get('receiving')
  getSummary(
    @Param('importOperationId', ParseUUIDPipe) importOperationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ImportReceivingSummary> {
    return this.service.getSummary(importOperationId, user.role);
  }

  @ApiOperation({
    summary: 'Recibir mercadería (y opcionalmente completar la importación)',
    description:
      'Crea UNA recepción de compra con la lógica existente (stock, valorización y reclasificación según las reglas vigentes) y la vincula al embarque, en una sola transacción. Con completeOperation=true completa la operación solo si ya no queda nada pendiente; si no se cumple, no se registra nada (409). Idempotency-Key obligatoria: mismo contenido devuelve el resultado original; contenido distinto, 409. La factura nunca se confirma automáticamente.',
  })
  @ApiParam({ name: 'importOperationId', format: 'uuid' })
  @ApiParam({ name: 'importShipmentId', format: 'uuid' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ description: 'Resultado (ImportReceivingResult).' })
  @ApiBadRequestResponse({ description: 'Validación por campo (kind FORM).' })
  @ApiConflictResponse({
    description:
      'Estado no válido, cantidades que exceden lo pendiente/disponible, stock/ubicación inválidos o conflicto de idempotencia.',
  })
  @Roles(...WRITE_ROLES)
  @Post('shipments/:importShipmentId/receive')
  receive(
    @Param('importOperationId', ParseUUIDPipe) importOperationId: string,
    @Param('importShipmentId', ParseUUIDPipe) importShipmentId: string,
    @Body() body: ReceiveFromImportDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<ImportReceivingResult> {
    return this.service.receive({
      importOperationId,
      importShipmentId,
      body,
      idempotencyKey,
      actorUserId: actor.id,
      requesterRole: actor.role,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary:
      'Vincular recepciones ya registradas al embarque (y opcionalmente completar)',
    description:
      'No genera movimientos de stock, valorización ni asientos: solo vincula cantidades de recepciones ACTIVE ya existentes (por ejemplo registradas desde Compras). Mismas reglas de cantidad, idempotencia y cierre atómico que "receive".',
  })
  @ApiParam({ name: 'importOperationId', format: 'uuid' })
  @ApiParam({ name: 'importShipmentId', format: 'uuid' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ description: 'Resultado (ImportReceivingResult).' })
  @ApiBadRequestResponse({ description: 'Validación por campo (kind FORM).' })
  @ApiConflictResponse({
    description:
      'Cantidades que exceden lo embarcado/recibido, vínculo duplicado, estado no válido o conflicto de idempotencia.',
  })
  @Roles(...WRITE_ROLES)
  @Post('shipments/:importShipmentId/link-receipts')
  linkReceipts(
    @Param('importOperationId', ParseUUIDPipe) importOperationId: string,
    @Param('importShipmentId', ParseUUIDPipe) importShipmentId: string,
    @Body() body: LinkExistingReceiptsDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<ImportReceivingResult> {
    return this.service.linkExisting({
      importOperationId,
      importShipmentId,
      body,
      idempotencyKey,
      actorUserId: actor.id,
      requesterRole: actor.role,
      ipAddress: request.ip ?? null,
    });
  }
}
