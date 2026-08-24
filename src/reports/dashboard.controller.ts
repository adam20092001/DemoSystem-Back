import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { DashboardService } from './dashboard.service';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { DashboardResponseDto } from './dto/dashboard-response.dto';
import { DashboardResult } from './types/dashboard';

/**
 * Los cuatro roles pueden llegar a GET /dashboard (la ruta en sí no
 * rechaza a nadie): la visibilidad SECCIÓN por sección (qué tarjeta ve cada
 * rol) es responsabilidad de DashboardService, no de este guard — WAREHOUSE
 * solo ve stock bajo, SELLER ve todo salvo stock bajo, ADMIN/MANAGEMENT ven
 * las 5 secciones.
 */
const DASHBOARD_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.SELLER,
  RoleName.WAREHOUSE,
] as const;

@ApiTags('Dashboard')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @ApiOperation({
    summary: 'Panel compuesto de indicadores operativos',
    description:
      'Respuesta única con hasta 5 secciones: sales, collections, lowStock, quotes, receivables. Visibilidad por rol: ADMIN y MANAGEMENT ven las 5; SELLER ve todo salvo lowStock (null); WAREHOUSE ve únicamente lowStock (el resto, null). Una sección oculta para el rol solicitante nunca se calcula. `from`/`to` (YYYY-MM-DD) deben venir juntos o ambos omitirse; si se omiten, el período por defecto es el mes calendario actual America/Lima (día 1 hasta hoy, ambos inclusive). sales/collections usan estado neto ACTUAL (una venta o pago anulado después del período no cuenta aunque su fecha caiga dentro); lowStock y receivables son de estado ACTUAL y no se filtran por período. No es contabilidad formal, no reemplaza los 5 reportes de Fase 9 Bloque B ni constituye una plataforma de Business Intelligence.',
  })
  @ApiOkResponse({ type: DashboardResponseDto })
  @ApiBadRequestResponse({
    description: 'Rango de fechas inválido o de un solo lado.',
  })
  @Roles(...DASHBOARD_ROLES)
  @Get()
  getDashboard(
    @Query() query: DashboardQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DashboardResult> {
    return this.dashboardService.getDashboard(query, user.role);
  }
}
