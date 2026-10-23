import { Controller, Get, Header, Query, StreamableFile } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  excelFileResponse,
  XLSX_CONTENT_TYPE,
} from '../common/excel/excel-file-response';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { ConsolidatedReconciliationQueryDto } from './dto/consolidated-reconciliation-query.dto';
import { ExpenseReconciliationQueryDto } from './dto/expense-reconciliation-query.dto';
import {
  ConsolidatedReconciliationResponseDto,
  ExpenseReconciliationResponseDto,
  ImportOperationSummaryResponseDto,
  ShipmentReconciliationResponseDto,
} from './dto/import-reports-response.dto';
import { ImportOperationSummaryQueryDto } from './dto/import-operation-summary-query.dto';
import { ShipmentReconciliationQueryDto } from './dto/shipment-reconciliation-query.dto';
import { ImportReportsService } from './import-reports.service';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;

/**
 * Reportes de SOLO LECTURA de importaciones (Fase B4): consolida B1
 * (ImportOperation/Shipment/ShipmentLine), B2 (ImportExpense/Allocation) y
 * B3 (ImportReceiptLink + atribución de costo). Mismo alcance de roles que
 * el resto del dominio contable/importaciones: ni SELLER ni WAREHOUSE
 * tienen ningún acceso a estos reportes ni a los montos de costo que
 * exponen. Ninguna ruta de este controller escribe nada — un monto
 * "asignado" o "atribuido" aquí NUNCA constituye una aprobación de
 * capitalización ni un costo de inventario reconocido (ver
 * ImportReportsService).
 */
@ApiTags('Import Reports')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('import-reports')
export class ImportReportsController {
  constructor(private readonly importReportsService: ImportReportsService) {}

  @ApiOperation({
    summary: 'Resumen por operación de importación',
    description:
      'Carga, embarques, costos (B2) y atribución a recepción física (B3) por operación. Nunca suma cantidades de distintas unidades ni montos de distintas monedas — ver cargoByUnit/expensesByCurrency.',
  })
  @ApiOkResponse({ type: ImportOperationSummaryResponseDto })
  @Roles(...READ_ROLES)
  @Get('operations')
  getOperationsSummary(
    @Query() query: ImportOperationSummaryQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.importReportsService.getOperationsSummary(query, user.role);
  }

  @ApiOperation({
    summary: 'Resumen por operación de importación — exportar a Excel (.xlsx)',
    description:
      'Mismos filtros que GET operations; exporta el resultado filtrado COMPLETO, una fila por (operación, moneda).',
  })
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse({ description: 'Archivo .xlsx del resumen de operaciones.' })
  @ApiBadRequestResponse({
    description: 'El resultado supera el máximo de filas exportables.',
  })
  @Roles(...READ_ROLES)
  @Get('operations/export.xlsx')
  @Header('Content-Type', XLSX_CONTENT_TYPE)
  async exportOperationsSummary(
    @Query() query: ImportOperationSummaryQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const buffer = await this.importReportsService.exportOperationsSummaryXlsx(
      query,
      user.role,
    );
    return excelFileResponse(buffer, 'resumen-operaciones-importacion');
  }

  @ApiOperation({
    summary: 'Reconciliación embarque / recepción física',
    description:
      'Compara, por línea de embarque, lo planificado contra lo vinculado a recepciones físicas ACTIVE (B3). Nunca equipara cantidad sin vincular con pérdida o faltante comprobado: puede ser mercadería aún no recibida o un vínculo administrativo pendiente. Nunca crea movimientos de inventario ni corrige stock.',
  })
  @ApiOkResponse({ type: ShipmentReconciliationResponseDto })
  @Roles(...READ_ROLES)
  @Get('shipments')
  getShipmentReconciliation(
    @Query() query: ShipmentReconciliationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.importReportsService.getShipmentReconciliation(
      query,
      user.role,
    );
  }

  @ApiOperation({
    summary:
      'Reconciliación embarque / recepción física — exportar a Excel (.xlsx)',
    description:
      'Mismos filtros que GET shipments; exporta el resultado filtrado COMPLETO, una fila por línea de embarque.',
  })
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse({
    description: 'Archivo .xlsx de la reconciliación de embarques/recepciones.',
  })
  @ApiBadRequestResponse({
    description: 'El resultado supera el máximo de filas exportables.',
  })
  @Roles(...READ_ROLES)
  @Get('shipments/export.xlsx')
  @Header('Content-Type', XLSX_CONTENT_TYPE)
  async exportShipmentReconciliation(
    @Query() query: ShipmentReconciliationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const buffer =
      await this.importReportsService.exportShipmentReconciliationXlsx(
        query,
        user.role,
      );
    return excelFileResponse(buffer, 'reconciliacion-embarques-recepciones');
  }

  @ApiOperation({
    summary: 'Reconciliación de gastos de importación',
    description:
      'Por gasto: asignación operativa (B2) y atribución a recepción física (B3), siempre en la moneda ORIGINAL del gasto — nunca convertida ni sumada junto a otra moneda. Reutiliza el cálculo de atribución corregido de B3 (prorratea sobre la cantidad EMBARCADA, nunca solo sobre lo ya recibido).',
  })
  @ApiOkResponse({ type: ExpenseReconciliationResponseDto })
  @Roles(...READ_ROLES)
  @Get('expenses')
  getExpenseReconciliation(
    @Query() query: ExpenseReconciliationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.importReportsService.getExpenseReconciliation(query, user.role);
  }

  @ApiOperation({
    summary:
      'Reconciliación de gastos de importación — exportar a Excel (.xlsx)',
    description:
      'Mismos filtros que GET expenses; exporta el resultado filtrado COMPLETO, una fila por gasto.',
  })
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse({
    description: 'Archivo .xlsx de la reconciliación de gastos de importación.',
  })
  @ApiBadRequestResponse({
    description: 'El resultado supera el máximo de filas exportables.',
  })
  @Roles(...READ_ROLES)
  @Get('expenses/export.xlsx')
  @Header('Content-Type', XLSX_CONTENT_TYPE)
  async exportExpenseReconciliation(
    @Query() query: ExpenseReconciliationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const buffer =
      await this.importReportsService.exportExpenseReconciliationXlsx(
        query,
        user.role,
      );
    return excelFileResponse(buffer, 'reconciliacion-gastos-importacion');
  }

  @ApiOperation({
    summary: 'Reconciliación consolidada de importaciones',
    description:
      'Clasifica cada operación como CONSISTENT, PARTIAL_PENDING_OPERATIONAL_LINK, PENDING_FX, PENDING_ACCOUNTING_POLICY o DATA_INCONSISTENCY, con los motivos derivados de los datos reales. Nunca reporta el monto asignado/atribuido como costo de inventario aprobado ni lo compara contra el mayor contable como si ya estuviera contabilizado — ver ImportReportsService.classifyReconciliation().',
  })
  @ApiOkResponse({ type: ConsolidatedReconciliationResponseDto })
  @Roles(...READ_ROLES)
  @Get('reconciliation')
  getConsolidatedReconciliation(
    @Query() query: ConsolidatedReconciliationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.importReportsService.getConsolidatedReconciliation(
      query,
      user.role,
    );
  }

  @ApiOperation({
    summary:
      'Reconciliación consolidada de importaciones — exportar a Excel (.xlsx)',
    description:
      'Mismos filtros que GET reconciliation; exporta el resultado filtrado COMPLETO, una fila por (operación, moneda).',
  })
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOkResponse({
    description: 'Archivo .xlsx de la reconciliación consolidada.',
  })
  @ApiBadRequestResponse({
    description: 'El resultado supera el máximo de filas exportables.',
  })
  @Roles(...READ_ROLES)
  @Get('reconciliation/export.xlsx')
  @Header('Content-Type', XLSX_CONTENT_TYPE)
  async exportConsolidatedReconciliation(
    @Query() query: ConsolidatedReconciliationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const buffer =
      await this.importReportsService.exportConsolidatedReconciliationXlsx(
        query,
        user.role,
      );
    return excelFileResponse(buffer, 'reconciliacion-consolidada-importacion');
  }
}
