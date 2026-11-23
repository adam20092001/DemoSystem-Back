import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { COOKIE_AUTH_NAME } from '../../config/swagger';
import { SafePurchaseInvoiceAttachmentResponseDto } from './dto/purchase-invoice-attachment-response.dto';
import {
  PurchaseInvoiceAttachmentFile,
  PurchaseInvoiceAttachmentsService,
} from './purchase-invoice-attachments.service';
import { SafePurchaseInvoiceAttachment } from './types/safe-purchase-invoice-attachment';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
  RoleName.PURCHASING,
] as const;
const WRITE_ROLES = [RoleName.ADMIN, RoleName.PURCHASING] as const;

/**
 * Cabeceras de entrega segura de un archivo servido por la API autenticada:
 * nunca se interpreta como HTML/script (nosniff + CSP restrictiva sin
 * ejecución), nunca se almacena en cachés compartidas y la descarga conserva el
 * nombre ORIGINAL saneado (codificado RFC 5987).
 */
function sendFile(
  res: Response,
  file: PurchaseInvoiceAttachmentFile,
  disposition: 'inline' | 'attachment',
): StreamableFile {
  const encoded = encodeURIComponent(file.fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const asciiFallback = file.fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  res.set({
    'Content-Type': file.mimeType,
    'Content-Length': String(file.fileSize),
    'Content-Disposition': `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  return new StreamableFile(file.stream);
}

/**
 * Documentos adjuntos de una factura de compra (R5). Autenticación por cookie
 * HttpOnly + rol ANTES de servir cualquier byte; un adjunto solo se entrega
 * bajo la factura a la que pertenece.
 */
@ApiTags('Purchase Invoice Attachments')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('purchase-invoices/:purchaseInvoiceId/attachments')
export class PurchaseInvoiceAttachmentsController {
  constructor(private readonly service: PurchaseInvoiceAttachmentsService) {}

  @ApiOperation({
    summary: 'Adjuntar un documento (PDF, JPG o PNG, máx. 10 MB)',
    description:
      'multipart/form-data con el campo "file". Se valida el contenido real (firma y estructura), no solo la extensión. Permitido en facturas DRAFT y CONFIRMED; no cambia el estado ni los importes de la factura. Cabecera opcional Idempotency-Key: mismo contenido devuelve la carga anterior (idempotentReplay=true); contenido distinto responde 409.',
  })
  @ApiParam({ name: 'purchaseInvoiceId', format: 'uuid' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: SafePurchaseInvoiceAttachmentResponseDto })
  @ApiNotFoundResponse({ description: 'La factura no existe.' })
  @ApiConflictResponse({
    description:
      'Factura anulada, o Idempotency-Key reutilizada con otro contenido.',
  })
  @ApiPayloadTooLargeResponse({ description: 'Excede 10 MB.' })
  @Roles(...WRITE_ROLES)
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Param('purchaseInvoiceId', ParseUUIDPipe) purchaseInvoiceId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafePurchaseInvoiceAttachment> {
    if (!file) {
      throw new BadRequestException('El campo file es obligatorio');
    }
    return this.service.upload({
      purchaseInvoiceId,
      file: {
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
      },
      idempotencyKey,
      actorUserId: actor.id,
      requesterRole: actor.role,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Listar los documentos activos de la factura' })
  @ApiParam({ name: 'purchaseInvoiceId', format: 'uuid' })
  @ApiOkResponse({ type: [SafePurchaseInvoiceAttachmentResponseDto] })
  @ApiNotFoundResponse({ description: 'La factura no existe.' })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Param('purchaseInvoiceId', ParseUUIDPipe) purchaseInvoiceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafePurchaseInvoiceAttachment[]> {
    return this.service.list(purchaseInvoiceId, user.role);
  }

  @ApiOperation({
    summary: 'Previsualizar un documento (inline, autenticado)',
  })
  @ApiParam({ name: 'purchaseInvoiceId', format: 'uuid' })
  @ApiParam({ name: 'attachmentId', format: 'uuid' })
  @ApiOkResponse({ description: 'Bytes originales con su Content-Type.' })
  @ApiNotFoundResponse({
    description: 'Inexistente, eliminado o de otra factura (mismo 404).',
  })
  @Roles(...READ_ROLES)
  @Get(':attachmentId/preview')
  async preview(
    @Param('purchaseInvoiceId', ParseUUIDPipe) purchaseInvoiceId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.service.openFile(
      purchaseInvoiceId,
      attachmentId,
      user.role,
    );
    return sendFile(res, file, 'inline');
  }

  @ApiOperation({ summary: 'Descargar el archivo original' })
  @ApiParam({ name: 'purchaseInvoiceId', format: 'uuid' })
  @ApiParam({ name: 'attachmentId', format: 'uuid' })
  @ApiOkResponse({ description: 'Bytes originales como adjunto.' })
  @ApiNotFoundResponse({
    description: 'Inexistente, eliminado o de otra factura (mismo 404).',
  })
  @Roles(...READ_ROLES)
  @Get(':attachmentId/download')
  async download(
    @Param('purchaseInvoiceId', ParseUUIDPipe) purchaseInvoiceId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.service.openFile(
      purchaseInvoiceId,
      attachmentId,
      user.role,
    );
    return sendFile(res, file, 'attachment');
  }

  @ApiOperation({
    summary: 'Eliminar un documento (solo con la factura en borrador)',
    description:
      'En una factura CONFIRMED los documentos se conservan: responde 409.',
  })
  @ApiParam({ name: 'purchaseInvoiceId', format: 'uuid' })
  @ApiParam({ name: 'attachmentId', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Eliminado (borrado lógico).' })
  @ApiNotFoundResponse({ description: 'No existe, o ya fue eliminado.' })
  @ApiConflictResponse({ description: 'La factura ya no está en borrador.' })
  @Roles(...WRITE_ROLES)
  @Delete(':attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('purchaseInvoiceId', ParseUUIDPipe) purchaseInvoiceId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<void> {
    await this.service.remove({
      purchaseInvoiceId,
      attachmentId,
      actorUserId: actor.id,
      requesterRole: actor.role,
      ipAddress: request.ip ?? null,
    });
  }
}

/**
 * Los mismos documentos de la factura vinculada, consultados desde una
 * operación de importación. No existe ninguna copia: se sirve el mismo archivo
 * con los mismos permisos de lectura de la compra.
 */
@ApiTags('Import Operations')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('import-operations/:importOperationId/documents')
export class ImportOperationDocumentsController {
  constructor(private readonly service: PurchaseInvoiceAttachmentsService) {}

  @ApiOperation({
    summary: 'Documentos de la factura de compra vinculada a la importación',
    description:
      'Operaciones históricas sin factura devuelven purchaseInvoiceId=null y documents=[].',
  })
  @ApiParam({ name: 'importOperationId', format: 'uuid' })
  @ApiNotFoundResponse({ description: 'La operación no existe.' })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Param('importOperationId', ParseUUIDPipe) importOperationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{
    importOperationId: string;
    purchaseInvoiceId: string | null;
    documents: SafePurchaseInvoiceAttachment[];
  }> {
    return this.service.listForImportOperation(importOperationId, user.role);
  }

  @ApiOperation({ summary: 'Previsualizar un documento (inline, autenticado)' })
  @ApiParam({ name: 'importOperationId', format: 'uuid' })
  @ApiParam({ name: 'attachmentId', format: 'uuid' })
  @Roles(...READ_ROLES)
  @Get(':attachmentId/preview')
  async preview(
    @Param('importOperationId', ParseUUIDPipe) importOperationId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.service.openFileForImportOperation(
      importOperationId,
      attachmentId,
      user.role,
    );
    return sendFile(res, file, 'inline');
  }

  @ApiOperation({ summary: 'Descargar el archivo original' })
  @ApiParam({ name: 'importOperationId', format: 'uuid' })
  @ApiParam({ name: 'attachmentId', format: 'uuid' })
  @Roles(...READ_ROLES)
  @Get(':attachmentId/download')
  async download(
    @Param('importOperationId', ParseUUIDPipe) importOperationId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.service.openFileForImportOperation(
      importOperationId,
      attachmentId,
      user.role,
    );
    return sendFile(res, file, 'attachment');
  }
}
