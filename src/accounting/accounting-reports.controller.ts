import { Controller, Get, Header, Query, StreamableFile } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { AccountingReportsService } from './accounting-reports.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  excelFileResponse,
  XLSX_CONTENT_TYPE,
} from '../common/excel/excel-file-response';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { JournalReportQueryDto } from './dto/journal-report-query.dto';
import { JournalReportResponseDto } from './dto/journal-report-response.dto';
import { LedgerReportQueryDto } from './dto/ledger-report-query.dto';
import { LedgerReportResponseDto } from './dto/ledger-report-response.dto';
import { TrialBalanceQueryDto } from './dto/trial-balance-query.dto';
import { TrialBalanceResponseDto } from './dto/trial-balance-response.dto';
import { JournalReportResult } from './types/journal-report.types';
import { LedgerReportResult } from './types/ledger-report.types';
import { TrialBalanceReportResult } from './types/trial-balance-report.types';

const READ_ROLES = [RoleName.ADMIN, RoleName.MANAGEMENT] as const;

/**
 * Reportes contables de SOLO LECTURA (Fase A3): Libro Diario, Libro Mayor
 * y Balance de comprobación, derivados exclusivamente de AccountingEntry/
 * AccountingEntryLine ya persistidos. Mismo alcance de roles que el resto
 * del dominio contable: ni SELLER ni WAREHOUSE tienen ningún acceso;
 * MANAGEMENT solo lee. Ninguna ruta de este controller escribe nada —
 * AccountingEngine sigue siendo el único punto de posteo.
 *
 * Nota de alcance (no es contabilidad SUNAT): estos reportes son
 * herramientas internas de pre-contabilidad, no libros electrónicos con
 * validez fiscal — misma advertencia ya aplicada al resto del módulo
 * (§4/§16 de CLAUDE.md).
 */
@ApiTags('Accounting Reports')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('accounting/reports')
export class AccountingReportsController {
  constructor(
    private readonly accountingReportsService: AccountingReportsService,
  ) {}

  @ApiOperation({
    summary: 'Libro Diario (paginado por asiento)',
    description:
      'La paginación corta por ASIENTO completo, nunca a mitad de uno: cada fila de `data` incluye todas sus líneas y sus totales debe/haber. Filtra por fecha contable (America/Lima), opcionalmente por periodo. Incluye asientos REVERSAL como filas independientes y nunca excluye un asiento porque la venta/pago asociado haya sido anulado.',
  })
  @ApiOkResponse({ type: JournalReportResponseDto })
  @ApiBadRequestResponse({ description: 'Rango de fechas inválido.' })
  @Roles(...READ_ROLES)
  @Get('journal')
  getJournal(
    @Query() query: JournalReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<JournalReportResult> {
    return this.accountingReportsService.getJournalReport(query, user.role);
  }

  @ApiOperation({
    summary: 'Libro Diario — exportar a Excel (.xlsx)',
    description:
      'Mismos filtros que GET journal; exporta el resultado filtrado COMPLETO (page/limit se ignoran), una fila por línea de asiento, hasta el máximo permitido de filas.',
  })
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse({ description: 'Archivo .xlsx del Libro Diario filtrado.' })
  @ApiBadRequestResponse({
    description:
      'Rango de fechas inválido, o el resultado supera el máximo de filas exportables.',
  })
  @Roles(...READ_ROLES)
  @Get('journal/export.xlsx')
  @Header('Content-Type', XLSX_CONTENT_TYPE)
  async exportJournal(
    @Query() query: JournalReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const buffer = await this.accountingReportsService.exportJournalXlsx(
      query,
      user.role,
    );
    return excelFileResponse(buffer, 'libro-diario');
  }

  @ApiOperation({
    summary: 'Libro Mayor de una cuenta (paginado)',
    description:
      'Saldo de apertura (todo el historial anterior a accountingDateFrom) + movimientos del rango con saldo acumulado en la dirección natural de la cuenta + saldo de cierre. Para una cuenta padre/agrupadora (isPostable=false) el resultado es necesariamente vacío: AccountingEngine nunca postea directamente contra una cuenta no postable — use una cuenta hija postable. Nunca se consolidan saldos de cuentas descendientes.',
  })
  @ApiOkResponse({ type: LedgerReportResponseDto })
  @ApiNotFoundResponse({ description: 'La cuenta no existe.' })
  @ApiBadRequestResponse({ description: 'Rango de fechas inválido.' })
  @Roles(...READ_ROLES)
  @Get('ledger')
  getLedger(
    @Query() query: LedgerReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LedgerReportResult> {
    return this.accountingReportsService.getLedgerReport(query, user.role);
  }

  @ApiOperation({
    summary: 'Libro Mayor — exportar a Excel (.xlsx)',
    description:
      'Mismos filtros que GET ledger; exporta apertura + TODOS los movimientos del rango + cierre (page/limit se ignoran).',
  })
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse({ description: 'Archivo .xlsx del Libro Mayor de la cuenta.' })
  @ApiNotFoundResponse({ description: 'La cuenta no existe.' })
  @ApiBadRequestResponse({
    description:
      'Rango de fechas inválido, o el resultado supera el máximo de filas exportables.',
  })
  @Roles(...READ_ROLES)
  @Get('ledger/export.xlsx')
  @Header('Content-Type', XLSX_CONTENT_TYPE)
  async exportLedger(
    @Query() query: LedgerReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const buffer = await this.accountingReportsService.exportLedgerXlsx(
      query,
      user.role,
    );
    return excelFileResponse(buffer, 'libro-mayor');
  }

  @ApiOperation({
    summary: 'Balance de comprobación (sin paginar)',
    description:
      'Siempre devuelve el conjunto completo filtrado (nunca paginado: la reconciliación de totales exige el conjunto completo). Sin filtro de cuentas, incluye todas las cuentas con saldo o movimiento relevante e informa si el total cuadra (`reconciliation.applicable=true`). Si se filtra un subconjunto explícito de cuentas (`accountIds`), `reconciliation.applicable=false` y los *Balanced quedan en null: un subconjunto arbitrario nunca tiene por qué cuadrar por sí solo.',
  })
  @ApiOkResponse({ type: TrialBalanceResponseDto })
  @ApiBadRequestResponse({
    description: 'Rango de fechas inválido, o accountIds vacío.',
  })
  @Roles(...READ_ROLES)
  @Get('trial-balance')
  getTrialBalance(
    @Query() query: TrialBalanceQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TrialBalanceReportResult> {
    return this.accountingReportsService.getTrialBalanceReport(
      query,
      user.role,
    );
  }

  @ApiOperation({
    summary: 'Balance de comprobación — exportar a Excel (.xlsx)',
    description:
      'Mismos filtros que GET trial-balance; exporta el conjunto completo.',
  })
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse({ description: 'Archivo .xlsx del balance de comprobación.' })
  @ApiBadRequestResponse({
    description:
      'Rango de fechas inválido, accountIds vacío, o el resultado supera el máximo de filas exportables.',
  })
  @Roles(...READ_ROLES)
  @Get('trial-balance/export.xlsx')
  @Header('Content-Type', XLSX_CONTENT_TYPE)
  async exportTrialBalance(
    @Query() query: TrialBalanceQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const buffer = await this.accountingReportsService.exportTrialBalanceXlsx(
      query,
      user.role,
    );
    return excelFileResponse(buffer, 'balance-de-comprobacion');
  }
}
