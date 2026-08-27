import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { COOKIE_AUTH_NAME } from '../../config/swagger';
import { FiscalSeriesResponseDto } from '../dto/fiscal-series-response.dto';
import { ListFiscalSeriesQueryDto } from '../dto/list-fiscal-series-query.dto';
import { FiscalSeriesService } from '../fiscal-series.service';
import { SafeFiscalSeries } from '../types/safe-fiscal-series';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.SELLER,
  RoleName.MANAGEMENT,
] as const;

@ApiTags('Fiscal Series')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({
  description: 'Rol activo sin permiso para este endpoint.',
})
@Controller('fiscal-series')
export class FiscalSeriesController {
  constructor(private readonly fiscalSeriesService: FiscalSeriesService) {}

  @ApiOperation({
    summary: 'Descubrir series fiscales disponibles (solo lectura)',
    description:
      'La emisión (POST /sales/:saleId/electronic-documents) exige una serie EXPLÍCITA: este endpoint existe para que el cliente pueda listar las disponibles. Sin paginación (catálogo pequeño por diseño). Nunca expone un "próximo número": currentNumber es puramente informativo y puede quedar obsoleto de inmediato ante emisión concurrente. Sin administración de series en este bloque (crear/editar/desactivar es un bloque dedicado futuro).',
  })
  @ApiOkResponse({ type: [FiscalSeriesResponseDto] })
  @Roles(...READ_ROLES)
  @Get()
  list(@Query() query: ListFiscalSeriesQueryDto): Promise<SafeFiscalSeries[]> {
    return this.fiscalSeriesService.list(query);
  }
}
