import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import type { Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import type { SireRegister } from './core/types';
import {
  SireDocumentsQueryDto,
  SireSampleFileQueryDto,
} from './dto/sire-demo-query.dto';
import {
  ListSireProposalsQueryDto,
  SireProposalListResponseDto,
  SireProposalResponseDto,
  UploadSireProposalBodyDto,
  UploadSireProposalDto,
} from './dto/sire-demo-proposal.dto';
import {
  SireContextResponseDto,
  SireCurrencyTotalsDto,
  SireDocumentsResponseDto,
} from './dto/sire-demo-response.dto';
import {
  ParseSireRegisterPipe,
  SireDemoEnabledGuard,
} from './sire-demo.guards';
import { SIRE_DEMO_MAX_FILE_BYTES } from './sire-demo.constants';
import { SireDemoProposalsService } from './sire-demo-proposals.service';
import { SireDemoService } from './sire-demo.service';

/**
 * ADMIN y ACCOUNTANT consultan y cargan/descartan propuestas (S2); MANAGEMENT
 * solo consulta. SELLER y WAREHOUSE no acceden a información tributaria de
 * conciliación. Alcance global (sin restricción por vendedor).
 */
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.ACCOUNTANT,
  RoleName.MANAGEMENT,
] as const;

const WRITE_ROLES = [RoleName.ADMIN, RoleName.ACCOUNTANT] as const;

@ApiTags('SIRE Demo')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiExtraModels(SireCurrencyTotalsDto)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({
  description:
    'Rol activo sin permiso, u origen DEMO_FIXTURES no habilitado (code SIRE_SOURCE_DISABLED).',
})
@UseGuards(SireDemoEnabledGuard)
@Controller('sire-demo')
export class SireDemoController {
  constructor(
    private readonly sireDemoService: SireDemoService,
    private readonly proposalsService: SireDemoProposalsService,
  ) {}

  @ApiOperation({
    summary: 'Contexto del módulo SIRE DEMO',
    description:
      'Modo DEMO (sin validez oficial), límites de carga y, por origen (POS / DEMO_FIXTURES), los periodos con documentos. Un 404 en esta ruta significa que el módulo no está disponible en este ambiente.',
  })
  @ApiOkResponse({ type: SireContextResponseDto })
  @Roles(...READ_ROLES)
  @Get('context')
  getContext(): Promise<SireContextResponseDto> {
    return this.sireDemoService.getContext();
  }

  @ApiOperation({
    summary: 'Previsualización de documentos del RVIE o RCE por periodo',
    description:
      'Documentos normalizados con alertas de datos y totales por moneda. `source` es obligatorio y explícito (POS o DEMO_FIXTURES): nunca se mezclan. Los códigos SUNAT, la regla del periodo y el tratamiento de IGV son PROVISIONALES (solo demostración). `internalStatus` es el estado interno del POS y nunca implica aceptación ante SUNAT.',
  })
  @ApiParam({ name: 'register', enum: ['rvie', 'rce'] })
  @ApiOkResponse({ type: SireDocumentsResponseDto })
  @ApiBadRequestResponse({
    description: 'register, source, period, flag o paginación inválidos.',
  })
  @Roles(...READ_ROLES)
  @Get('registers/:register/documents')
  getDocuments(
    @Param('register', new ParseSireRegisterPipe()) register: SireRegister,
    @Query() query: SireDocumentsQueryDto,
  ): Promise<SireDocumentsResponseDto> {
    return this.sireDemoService.getDocuments(register, query);
  }

  @ApiOperation({
    summary: 'Descargar un archivo DEMO_V1 de ejemplo',
    description:
      'Archivo .txt en el formato propio DEMO_V1 (NO es un layout oficial de SUNAT). Con DEMO_FIXTURES devuelve el archivo versionado; con POS lo deriva de los documentos reales del periodo con mutaciones deterministas (sin documentos: 409 POS_SOURCE_EMPTY).',
  })
  @ApiParam({ name: 'register', enum: ['rvie', 'rce'] })
  @ApiProduces('text/plain')
  @ApiOkResponse({
    description: 'Archivo DEMO_V1 (text/plain; charset=utf-8, attachment).',
    content: { 'text/plain': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({
    description:
      'Parámetros inválidos o periodo sin fixtures (FIXTURE_PERIOD_UNAVAILABLE).',
  })
  @ApiConflictResponse({
    description: 'POS sin documentos representables (POS_SOURCE_EMPTY).',
  })
  @Roles(...READ_ROLES)
  @Get('registers/:register/sample-file')
  async getSampleFile(
    @Param('register', new ParseSireRegisterPipe()) register: SireRegister,
    @Query() query: SireSampleFileQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const file = await this.sireDemoService.getSampleFile(register, query);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName}"`,
    );
    res.setHeader('X-Sire-Mode', 'DEMO');
    return file.content;
  }

  @ApiOperation({
    summary: 'Cargar una propuesta DEMO_V1',
    description:
      'multipart/form-data con `file` (.txt, máx. 2 MB / 5000 filas) y `source`, `register`, `period`. Valida TODO el archivo antes de persistir (todo o nada), es idempotente por SHA-256 (un archivo activo ya importado responde 200 con reused=true, sin duplicar) y admite hasta 10 propuestas activas por origen, registro y periodo. Con DEMO_FIXTURES la cabecera debe declarar una versión de fixtures existente que incluya el periodo.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadSireProposalBodyDto })
  @ApiCreatedResponse({ type: SireProposalResponseDto })
  @ApiOkResponse({
    type: SireProposalResponseDto,
    description: 'Archivo ya importado y activo (reused=true).',
  })
  @ApiBadRequestResponse({
    description:
      'Archivo o formulario inválido (SIRE_FILE_REQUIRED, SIRE_FILE_EXTENSION_INVALID, SIRE_FILE_INVALID, FIXTURE_VERSION_UNKNOWN, FIXTURE_PERIOD_UNAVAILABLE).',
  })
  @ApiConflictResponse({
    description:
      'Ya hay 10 propuestas activas para el origen/registro/periodo (SIRE_PROPOSAL_LIMIT_REACHED).',
  })
  @Roles(...WRITE_ROLES)
  @Post('proposals')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: SIRE_DEMO_MAX_FILE_BYTES, files: 1, fields: 10 },
    }),
  )
  async uploadProposal(
    @Body() dto: UploadSireProposalDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SireProposalResponseDto> {
    const { response, created } = await this.proposalsService.upload(
      dto,
      file,
      { actorUserId: actor.id, ipAddress: request.ip ?? null },
    );
    res.status(created ? 201 : 200);
    return response;
  }

  @ApiOperation({
    summary: 'Listar propuestas importadas',
    description:
      'Paginado, con filtros opcionales. `reconcilable` indica si está IMPORTED y su origen está disponible. Sin `source`, las propuestas DEMO_FIXTURES solo aparecen si ese origen está habilitado.',
  })
  @ApiOkResponse({ type: SireProposalListResponseDto })
  @Roles(...READ_ROLES)
  @Get('proposals')
  listProposals(
    @Query() query: ListSireProposalsQueryDto,
  ): Promise<SireProposalListResponseDto> {
    return this.proposalsService.list(query);
  }

  @ApiOperation({
    summary: 'Descartar una propuesta (descarte lógico)',
    description:
      'Marca la propuesta como DISCARDED registrando fecha y usuario; conserva sus líneas. Un segundo descarte responde 409.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SireProposalResponseDto })
  @ApiNotFoundResponse({ description: 'SIRE_PROPOSAL_NOT_FOUND.' })
  @ApiConflictResponse({ description: 'SIRE_PROPOSAL_ALREADY_DISCARDED.' })
  @Roles(...WRITE_ROLES)
  @Post('proposals/:id/discard')
  @HttpCode(200)
  discardProposal(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SireProposalResponseDto> {
    return this.proposalsService.discard(id, {
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
