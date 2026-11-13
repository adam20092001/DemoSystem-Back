import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import type { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import type { SireRegister } from './core/types';
import {
  SireDocumentsQueryDto,
  SireSampleFileQueryDto,
} from './dto/sire-demo-query.dto';
import {
  SireContextResponseDto,
  SireCurrencyTotalsDto,
  SireDocumentsResponseDto,
} from './dto/sire-demo-response.dto';
import {
  ParseSireRegisterPipe,
  SireDemoEnabledGuard,
} from './sire-demo.guards';
import { SireDemoService } from './sire-demo.service';

/**
 * ADMIN y ACCOUNTANT consultan (y cargarán propuestas en S2); MANAGEMENT solo
 * consulta. SELLER y WAREHOUSE no acceden a información tributaria de
 * conciliación. Alcance global (sin restricción por vendedor).
 */
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.ACCOUNTANT,
  RoleName.MANAGEMENT,
] as const;

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
  constructor(private readonly sireDemoService: SireDemoService) {}

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
}
