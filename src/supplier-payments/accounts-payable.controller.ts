import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
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
import { AccountsPayableService } from './accounts-payable.service';
import {
  AccountsPayableDetailResponseDto,
  PaginatedAccountsPayableResponseDto,
} from './dto/accounts-payable-response.dto';
import { ListAccountsPayableQueryDto } from './dto/list-accounts-payable-query.dto';
import {
  AccountsPayableDetail,
  AccountsPayableItem,
} from './types/accounts-payable-item';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;

/** Consulta de cuentas por pagar (Fase A5.3): solo lectura. */
@ApiTags('Accounts Payable')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('accounts-payable')
export class AccountsPayableController {
  constructor(
    private readonly accountsPayableService: AccountsPayableService,
  ) {}

  @ApiOperation({
    summary: 'Listar cuentas por pagar (paginado, con filtros)',
    description:
      'Una cuenta por pagar es siempre una PurchaseInvoice CONFIRMED. paidAmount/balanceDue/status se calculan en tiempo de lectura a partir de SupplierPaymentAllocation de pagos ACTIVE — nunca una columna duplicada. Orden fijo: deuda más antigua primero (issueDate ascendente).',
  })
  @ApiOkResponse({ type: PaginatedAccountsPayableResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListAccountsPayableQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<AccountsPayableItem>> {
    return this.accountsPayableService.list(query, user.role);
  }

  @ApiOperation({
    summary:
      'Detalle de una cuenta por pagar + historial completo de aplicación de pagos',
    description:
      'Incluye pagos ACTIVE y CANCELLED en el historial; los CANCELLED quedan excluidos del cálculo de saldo pendiente.',
  })
  @ApiParam({ name: 'purchaseInvoiceId', format: 'uuid' })
  @ApiOkResponse({ type: AccountsPayableDetailResponseDto })
  @ApiNotFoundResponse({
    description: 'La factura no existe o no está CONFIRMED.',
  })
  @Roles(...READ_ROLES)
  @Get(':purchaseInvoiceId')
  getDetail(
    @Param('purchaseInvoiceId', ParseUUIDPipe) purchaseInvoiceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AccountsPayableDetail> {
    return this.accountsPayableService.getDetail(purchaseInvoiceId, user.role);
  }
}
