import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCookieAuth,
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
import {
  excelFileResponse,
  XLSX_CONTENT_TYPE,
} from '../common/excel/excel-file-response';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaginatedResult } from '../common/types/paginated-result';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { AccountsPayableService } from './accounts-payable.service';
import { AgingReportResponseDto } from './dto/accounts-payable-aging-response.dto';
import { AccountsPayableFilterQueryDto } from './dto/accounts-payable-filter-query.dto';
import { ApReconciliationReportResponseDto } from './dto/accounts-payable-reconciliation-response.dto';
import {
  AccountsPayableDetailResponseDto,
  PaginatedAccountsPayableResponseDto,
} from './dto/accounts-payable-response.dto';
import { AccountsPayableSummaryResponseDto } from './dto/accounts-payable-summary-response.dto';
import { ListAccountsPayableQueryDto } from './dto/list-accounts-payable-query.dto';
import { AgingReport } from './types/accounts-payable-aging';
import { ApReconciliationReport } from './types/accounts-payable-reconciliation';
import {
  AccountsPayableDetail,
  AccountsPayableItem,
} from './types/accounts-payable-item';
import { AccountsPayableSummaryReport } from './types/accounts-payable-summary';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;

/**
 * Cuentas por pagar (Fase A5.3) y sus reportes (Fase A5.4): solo lectura.
 * Las subrutas literales (summary/aging/reconciliation/export.xlsx) se
 * declaran ANTES de `:purchaseInvoiceId` — NestJS resuelve rutas en el
 * orden en que se registran los métodos, así que un literal después del
 * parámetro quedaría atrapado por él (y ParseUUIDPipe lo rechazaría con
 * 400 en vez de alcanzar el método correcto).
 */
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
      'Una cuenta por pagar es siempre una PurchaseInvoice CONFIRMED. paidAmount/balanceDue/status/agingBucket/daysOverdue se calculan en tiempo de lectura — nunca una columna duplicada. Orden fijo: deuda más antigua primero (issueDate ascendente).',
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
      'Exportar el listado detallado de cuentas por pagar a Excel (.xlsx)',
    description:
      'Mismos filtros que GET /accounts-payable (page/limit se ignoran — exporta el resultado completo, hasta el máximo permitido).',
  })
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse({
    description: 'Archivo .xlsx con las cuentas por pagar filtradas.',
  })
  @Roles(...READ_ROLES)
  @Get('export.xlsx')
  @Header('Content-Type', XLSX_CONTENT_TYPE)
  async exportDetailedXlsx(
    @Query() query: ListAccountsPayableQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const buffer = await this.accountsPayableService.exportDetailedXlsx(
      query,
      user.role,
    );
    return excelFileResponse(buffer, 'cuentas-por-pagar');
  }

  @ApiOperation({
    summary:
      'Resumen de cuentas por pagar agrupado por proveedor + total general',
  })
  @ApiOkResponse({ type: AccountsPayableSummaryResponseDto })
  @Roles(...READ_ROLES)
  @Get('summary')
  getSummary(
    @Query() query: AccountsPayableFilterQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AccountsPayableSummaryReport> {
    return this.accountsPayableService.getSummary(query, user.role);
  }

  @ApiOperation({
    summary: 'Exportar el resumen por proveedor a Excel (.xlsx)',
  })
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse({ description: 'Archivo .xlsx con el resumen por proveedor.' })
  @Roles(...READ_ROLES)
  @Get('summary/export.xlsx')
  @Header('Content-Type', XLSX_CONTENT_TYPE)
  async exportSummaryXlsx(
    @Query() query: AccountsPayableFilterQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const buffer = await this.accountsPayableService.exportSummaryXlsx(
      query,
      user.role,
    );
    return excelFileResponse(buffer, 'cuentas-por-pagar-resumen');
  }

  @ApiOperation({
    summary: 'Antigüedad de deuda (aging) por categoría y por proveedor',
    description:
      'Calculado SIEMPRE sobre el saldo pendiente VIGENTE a la fecha de generación — nunca un saldo histórico reconstruido a una fecha de corte pasada (ver `limitations` en la respuesta). Categorías: NOT_OVERDUE, OVERDUE_1_30, OVERDUE_31_60, OVERDUE_61_90, OVERDUE_90_PLUS, NO_DUE_DATE.',
  })
  @ApiOkResponse({ type: AgingReportResponseDto })
  @Roles(...READ_ROLES)
  @Get('aging')
  getAging(
    @Query() query: AccountsPayableFilterQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AgingReport> {
    return this.accountsPayableService.getAging(query, user.role);
  }

  @ApiOperation({
    summary: 'Exportar el reporte de antigüedad de deuda a Excel (.xlsx)',
  })
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse({ description: 'Archivo .xlsx con la antigüedad de deuda.' })
  @Roles(...READ_ROLES)
  @Get('aging/export.xlsx')
  @Header('Content-Type', XLSX_CONTENT_TYPE)
  async exportAgingXlsx(
    @Query() query: AccountsPayableFilterQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const buffer = await this.accountsPayableService.exportAgingXlsx(
      query,
      user.role,
    );
    return excelFileResponse(buffer, 'cuentas-por-pagar-antiguedad');
  }

  @ApiOperation({
    summary: 'Conciliación de cuentas por pagar (SOLO LECTURA)',
    description:
      'Compara el saldo operativo (A5.3) contra lo realmente posteado por AccountingEngine, agrupado por la cuenta de pasivo HISTÓRICA de cada factura — nunca el mapeo vigente de ACCOUNTS_PAYABLE. Nunca crea asientos correctivos ni modifica ningún saldo; ver `limitations` en la respuesta.',
  })
  @ApiOkResponse({ type: ApReconciliationReportResponseDto })
  @Roles(...READ_ROLES)
  @Get('reconciliation')
  getReconciliation(
    @Query() query: AccountsPayableFilterQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApReconciliationReport> {
    return this.accountsPayableService.getReconciliation(query, user.role);
  }

  @ApiOperation({
    summary: 'Exportar el resultado de la conciliación a Excel (.xlsx)',
  })
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse({
    description: 'Archivo .xlsx con el detalle de la conciliación.',
  })
  @Roles(...READ_ROLES)
  @Get('reconciliation/export.xlsx')
  @Header('Content-Type', XLSX_CONTENT_TYPE)
  async exportReconciliationXlsx(
    @Query() query: AccountsPayableFilterQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const buffer = await this.accountsPayableService.exportReconciliationXlsx(
      query,
      user.role,
    );
    return excelFileResponse(buffer, 'cuentas-por-pagar-conciliacion');
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
