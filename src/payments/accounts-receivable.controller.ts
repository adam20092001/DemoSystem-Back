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
import { PaginatedResult } from '../common/types/paginated-result';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { AccountsReceivableService } from './accounts-receivable.service';
import { PaginatedReceivablesResponseDto } from './dto/accounts-receivable-response.dto';
import { ListReceivablesQueryDto } from './dto/list-receivables-query.dto';
import { ReceivableItem } from './types/receivable-item';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.SELLER,
  RoleName.MANAGEMENT,
] as const;

@ApiTags('Accounts Receivable')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('accounts-receivable')
export class AccountsReceivableController {
  constructor(
    private readonly accountsReceivableService: AccountsReceivableService,
  ) {}

  @ApiOperation({
    summary: 'Listar cuentas por cobrar (paginado, con filtros)',
    description:
      'Incluye únicamente ventas ACTIVE con saldo pendiente (balanceDue) positivo; excluye siempre las ventas ANULADAS, incluso si su saldo histórico congelado es mayor que 0. Público general nunca aparece (su saldo pendiente siempre es 0 por invariante de base de datos). No se excluye a un cliente actualmente BLOCKED si la deuda es real. Orden fijo: deuda más antigua primero (confirmedAt ascendente). daysOutstanding son días de calendario desde la fecha de negocio America/Lima de confirmación, no una medida de mora contra una fecha de vencimiento (no existe dueDate en el MVP). Esta consulta no es un libro contable formal.',
  })
  @ApiOkResponse({ type: PaginatedReceivablesResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros o rango de fechas inválido.' })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListReceivablesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<ReceivableItem>> {
    return this.accountsReceivableService.list(query, user.role);
  }
}
