import {
  Body,
  Controller,
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
  ApiNotFoundResponse,
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
import { COOKIE_AUTH_NAME } from '../../config/swagger';
import { ElectronicDocumentsService } from '../electronic-documents.service';
import { ElectronicDocumentResponseDto } from '../dto/electronic-document-response.dto';
import { IssueElectronicDocumentDto } from '../dto/issue-electronic-document.dto';

/**
 * Mismos roles de escritura ya vigentes en Ventas (WRITE_ROLES de
 * SalesController, Bloque 11D §5/§6: descubierto y preservado, no
 * reinventado). SELLER tiene acceso total sobre cualquier venta, sin
 * restricción de propiedad — mismo criterio exacto que Sales.
 */
const ISSUE_ROLES = [RoleName.ADMIN, RoleName.SELLER] as const;

@ApiTags('Electronic Invoicing')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({
  description: 'Rol activo sin permiso para este endpoint.',
})
@Controller('sales/:saleId/electronic-documents')
export class SaleElectronicDocumentsController {
  constructor(
    private readonly electronicDocumentsService: ElectronicDocumentsService,
  ) {}

  @ApiOperation({
    summary: 'Emitir un documento fiscal (FACTURA o BOLETA) para una venta',
    description:
      'FACTURA/BOLETA son documentos fiscales SEPARADOS de la Sale comercial (Fase 11): la venta sigue siendo la única fuente de verdad económica; este documento es un agregado fiscal aparte. documentType y series son SIEMPRE explícitos — nunca se elige automáticamente la primera serie activa ni se infiere el tipo desde el cliente. Un rechazo FUNCIONAL del proveedor (REJECTED) es un resultado definitivo válido: responde 201 igualmente, porque el documento fiscal se creó y recibió una resolución. Solo un fallo TÉCNICO o un resultado DESCONOCIDO del proveedor responde 503 (ver abajo). El proveedor actual es "MOCK" (demo): su ACCEPTED nunca implica una aceptación real de SUNAT.',
  })
  @ApiParam({ name: 'saleId', format: 'uuid' })
  @ApiCreatedResponse({
    type: ElectronicDocumentResponseDto,
    description:
      'El documento fiscal se creó y recibió una resolución definitiva del proveedor (ACCEPTED o REJECTED).',
  })
  @ApiBadRequestResponse({
    description:
      'Body inválido, o el emisor (CompanySettings) no cumple los requisitos fiscales mínimos.',
  })
  @ApiNotFoundResponse({ description: 'La venta no existe.' })
  @ApiConflictResponse({
    description:
      'La venta está anulada; ya tiene un documento fiscal primario (FACTURA o BOLETA), sin importar su estado; o el cliente congelado en la venta no cumple las reglas de FACTURA/BOLETA.',
  })
  @ApiServiceUnavailableResponse({
    description:
      'Fallo técnico confirmado (el documento queda SUBMISSION_FAILED, reintentable) o resultado desconocido del proveedor (el documento queda SUBMITTED, NO reintentable automáticamente).',
  })
  @Roles(...ISSUE_ROLES)
  @Post()
  async issue(
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Body() dto: IssueElectronicDocumentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<ElectronicDocumentResponseDto> {
    const result = await this.electronicDocumentsService.issue({
      saleId,
      documentType: dto.documentType,
      series: dto.series,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
    // issue() devuelve el snapshot INTERNO del motor (incluye
    // providerExternalId/fiscalSeriesId, de uso exclusivo interno): la
    // respuesta HTTP siempre pasa por findDetail() para obtener la forma
    // pública segura, nunca exponiendo el snapshot interno tal cual.
    return this.electronicDocumentsService.findDetail(result.id);
  }
}
