import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Patch,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { DocumentType, RoleName } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { DocumentSequenceResponseDto } from './dto/document-sequence-response.dto';
import { UpdateDocumentSequenceDto } from './dto/update-document-sequence.dto';
import { SequenceAdminService } from './sequence-admin.service';
import { SafeDocumentSequence } from './types/safe-document-sequence';

const READ_ROLES = [RoleName.ADMIN, RoleName.MANAGEMENT] as const;

/**
 * Administración de correlativos de documentos (Fase 10, Bloque D). Rutas
 * anidadas bajo /configuration/sequences deliberadamente en un controller
 * propio (no en ConfigurationController) para no mezclar metadata de rutas
 * de dos recursos distintos (CompanySettings singleton vs. colección de
 * DocumentSequence). Controller delgado: toda la lógica vive en
 * SequenceAdminService; nunca se importa PrismaService/AuditService aquí.
 *
 * Nunca existe aquí (ni en ningún otro controller) un endpoint que consuma o
 * previsualice el próximo número de una secuencia: la única vía de
 * generación es DocumentSequenceService.next(), invocado exclusivamente
 * desde QuotesService/SalesService dentro de su propia transacción de
 * negocio.
 */
@ApiTags('Configuration')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('configuration/sequences')
export class SequenceAdminController {
  constructor(private readonly sequenceAdminService: SequenceAdminService) {}

  @ApiOperation({
    summary: 'Listar las secuencias de documentos (QUOTE, SALE)',
    description:
      'Solo expone el estado administrable (prefix/padding/currentNumber); nunca calcula ni expone un "próximo número". El frontend nunca genera números de documento: siempre los asigna el backend al confirmar la cotización/venta.',
  })
  @ApiOkResponse({ type: DocumentSequenceResponseDto, isArray: true })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<SafeDocumentSequence[]> {
    return this.sequenceAdminService.listSequences(actor.role);
  }

  @ApiOperation({
    summary:
      'Actualizar prefix/padding/currentNumber de una secuencia de documentos',
    description:
      'Solo ADMIN. Los cambios afectan únicamente a los documentos generados a partir de este momento: los números de Quote/Sale ya emitidos son históricos y nunca se modifican. currentNumber puede mantenerse igual o avanzar; nunca puede disminuir respecto del valor actual en base de datos (409 si se intenta), garantizado con bloqueo de fila (SELECT ... FOR UPDATE) contra la generación automática concurrente.',
  })
  @ApiParam({ name: 'documentType', enum: DocumentType })
  @ApiOkResponse({ type: DocumentSequenceResponseDto })
  @ApiBadRequestResponse({
    description:
      'documentType inválido, payload vacío, o prefix/padding/currentNumber fuera de rango.',
  })
  @ApiConflictResponse({
    description:
      'currentNumber solicitado es menor que el valor actual en base de datos.',
  })
  @Roles(RoleName.ADMIN)
  @Patch(':documentType')
  update(
    @Param('documentType', new ParseEnumPipe(DocumentType))
    documentType: DocumentType,
    @Body() dto: UpdateDocumentSequenceDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeDocumentSequence> {
    return this.sequenceAdminService.updateSequence({
      documentType,
      prefix: dto.prefix,
      padding: dto.padding,
      currentNumber: dto.currentNumber,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
      requesterRole: actor.role,
    });
  }
}
