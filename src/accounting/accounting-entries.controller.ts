import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaginatedResult } from '../common/types/paginated-result';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { AccountingService } from './accounting.service';
import {
  AccountingEntryResponseDto,
  PaginatedAccountingEntriesResponseDto,
} from './dto/accounting-entry-response.dto';
import { ListAccountingEntriesQueryDto } from './dto/list-accounting-entries-query.dto';
import {
  SafeAccountingEntry,
  SafeAccountingEntryListItem,
} from './types/safe-accounting-entry';

const READ_ROLES = [RoleName.ADMIN, RoleName.MANAGEMENT] as const;

@ApiTags('Basic Accounting')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('accounting/entries')
export class AccountingEntriesController {
  constructor(private readonly accountingService: AccountingService) {}

  @ApiOperation({
    summary: 'Listar asientos contables (paginado, con filtros)',
    description:
      'Libro diario interno de pre-contabilidad automática, generado por el motor de Ventas/Pagos. No reemplaza un software contable formal ni constituye contabilidad SUNAT/PLE. Fila compacta: sin líneas ni actor (ver el detalle en GET /accounting/entries/:id). Orden fijo cronológico: postedAt/createdAt ascendente (más antiguo primero).',
  })
  @ApiOkResponse({ type: PaginatedAccountingEntriesResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros o rango de fechas inválido.' })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListAccountingEntriesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeAccountingEntryListItem>> {
    return this.accountingService.listEntries(query, user.role);
  }

  @ApiOperation({
    summary: 'Obtener el detalle de un asiento contable',
    description:
      'Incluye las líneas del asiento (con la cuenta ya resuelta) y el usuario que lo registró. Un asiento de reversa referencia al asiento original anulado vía reversesEntryId.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AccountingEntryResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeAccountingEntry> {
    return this.accountingService.findEntry(id, user.role);
  }
}
