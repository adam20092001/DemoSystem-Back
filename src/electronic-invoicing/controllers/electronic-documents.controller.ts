import {
  Controller,
  Get,
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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
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
import {
  ElectronicDocumentResponseDto,
  PaginatedElectronicDocumentsResponseDto,
} from '../dto/electronic-document-response.dto';
import { ListElectronicDocumentsQueryDto } from '../dto/list-electronic-documents-query.dto';
import { ElectronicDocumentsService } from '../electronic-documents.service';
import { SafeElectronicDocumentListItem } from '../types/safe-electronic-document';

/**
 * Mismos roles de lectura ya vigentes en Ventas (READ_ROLES de
 * SalesController, Bloque 11D §6/§10/§13: descubierto y preservado). Sin
 * restricción de propiedad por vendedor — SELLER ve todos los documentos
 * fiscales, igual que ve todas las ventas.
 */
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.SELLER,
  RoleName.MANAGEMENT,
] as const;
/** Mismo criterio que CANCEL_ROLES de Ventas: única acción sensible reservada a ADMIN. */
const RETRY_ROLES = [RoleName.ADMIN] as const;

@ApiTags('Electronic Invoicing')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({
  description: 'Rol activo sin permiso para este endpoint.',
})
@Controller('electronic-documents')
export class ElectronicDocumentsController {
  constructor(
    private readonly electronicDocumentsService: ElectronicDocumentsService,
  ) {}

  @ApiOperation({
    summary: 'Listar documentos fiscales (paginado, con filtros)',
    description:
      'SELLER tiene acceso total (sin restricción de propiedad, mismo criterio que GET /sales). El rango issuedFrom/issuedTo usa fechas de negocio America/Lima. Nunca incluye ítems (ver el detalle).',
  })
  @ApiOkResponse({ type: PaginatedElectronicDocumentsResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros o rango de fechas inválido.' })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListElectronicDocumentsQueryDto,
  ): Promise<PaginatedResult<SafeElectronicDocumentListItem>> {
    return this.electronicDocumentsService.list(query);
  }

  @ApiOperation({
    summary: 'Obtener el detalle de un documento fiscal (incluye ítems)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ElectronicDocumentResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ElectronicDocumentResponseDto> {
    return this.electronicDocumentsService.findDetail(id);
  }

  @ApiOperation({
    summary: 'Reintentar el envío de un documento fiscal (solo ADMIN)',
    description:
      'Solo admitido cuando el documento está en SUBMISSION_FAILED. Reutiliza la MISMA serie/número/ítems ya asignados: nunca crea otro documento fiscal ni asigna un número nuevo. Un documento SUBMITTED (resultado remoto desconocido) NO es reintentable por este endpoint — es un estado terminal en espera de reconciliación futura, no un fallo confirmado.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({
    type: ElectronicDocumentResponseDto,
    description: 'Resolución definitiva del reintento (ACCEPTED o REJECTED).',
  })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'El documento no está en SUBMISSION_FAILED (CREATED, SUBMITTED, ACCEPTED o REJECTED).',
  })
  @ApiServiceUnavailableResponse({
    description:
      'Nuevo fallo técnico (vuelve a SUBMISSION_FAILED) o resultado desconocido (queda SUBMITTED) del proveedor.',
  })
  @Roles(...RETRY_ROLES)
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  async retry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<ElectronicDocumentResponseDto> {
    const result = await this.electronicDocumentsService.retrySubmission(
      id,
      actor.id,
      request.ip ?? null,
    );
    // Mismo criterio que la emisión: la respuesta HTTP siempre pasa por
    // findDetail() para la forma pública segura, nunca el snapshot interno.
    return this.electronicDocumentsService.findDetail(result.id);
  }
}
