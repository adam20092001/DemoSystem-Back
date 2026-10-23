import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaginatedResult } from '../common/types/paginated-result';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { AllocateImportExpenseDto } from './dto/allocate-import-expense.dto';
import { CancelImportExpenseDto } from './dto/cancel-import-expense.dto';
import { CreateImportExpenseDto } from './dto/create-import-expense.dto';
import {
  ImportExpenseAllocationBatchResponseDto,
  ImportExpenseAllocationPreviewResponseDto,
} from './dto/import-expense-allocation-batch-response.dto';
import {
  ImportExpenseResponseDto,
  PaginatedImportExpensesResponseDto,
} from './dto/import-expense-response.dto';
import { ListImportExpensesQueryDto } from './dto/list-import-expenses-query.dto';
import { UpdateImportExpenseDto } from './dto/update-import-expense.dto';
import { ImportExpensesService } from './import-expenses.service';
import { SafeImportExpense } from './types/safe-import-expense';
import { SafeImportExpenseAllocationBatch } from './types/safe-import-expense-allocation-batch';

const WRITE_ROLES = [RoleName.ADMIN] as const;
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;

/**
 * Registro de gastos de importación, ANIDADO bajo una operación (Fase
 * B2). Mismo prefijo que ImportOperationsController (`import-operations`)
 * — controller SEPARADO a propósito, para no tocar el archivo ya
 * validado de B1 (mismo criterio exacto que
 * PurchaseInvoiceReceiptsController frente a PurchaseInvoicesController).
 */
@ApiTags('Import Operations')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('import-operations')
export class ImportOperationExpensesController {
  constructor(private readonly importExpensesService: ImportExpensesService) {}

  @ApiOperation({
    summary:
      'Listar los gastos de una operación de importación (paginado, con filtros)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PaginatedImportExpensesResponseDto })
  @ApiNotFoundResponse({ description: 'La operación no existe.' })
  @Roles(...READ_ROLES)
  @Get(':id/expenses')
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListImportExpensesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeImportExpense>> {
    return this.importExpensesService.listByOperation(id, query, user.role);
  }

  @ApiOperation({
    summary:
      'Registrar un gasto de importación bajo una operación (solo ADMIN; nace DRAFT)',
    description:
      'category es descriptiva, nunca una clasificación contable automática. Nunca genera asientos, pagos a proveedor, valorización ni movimientos de stock. supplierId/purchaseInvoiceLineId son opcionales e independientes del proveedor de la mercadería.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: ImportExpenseResponseDto })
  @ApiBadRequestResponse({
    description: 'Payload inválido, proveedor/línea de factura inexistente.',
  })
  @ApiNotFoundResponse({ description: 'La operación no existe.' })
  @ApiConflictResponse({
    description: 'La línea de factura referenciada no está CONFIRMED.',
  })
  @Roles(...WRITE_ROLES)
  @Post(':id/expenses')
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateImportExpenseDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportExpense> {
    return this.importExpensesService.create({
      importOperationId: id,
      category: dto.category,
      description: dto.description,
      supplierId: dto.supplierId,
      purchaseInvoiceLineId: dto.purchaseInvoiceLineId,
      documentType: dto.documentType,
      documentReference: dto.documentReference,
      expenseDate: dto.expenseDate,
      currencyCode: dto.currencyCode,
      amount: dto.amount,
      remarks: dto.remarks,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}

/** Consulta de detalle/edición, transiciones explícitas, y asignación de costo de UN gasto de importación, por su propio id (Fase B2). */
@ApiTags('Import Operations')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('import-expenses')
export class ImportExpensesController {
  constructor(private readonly importExpensesService: ImportExpensesService) {}

  @ApiOperation({ summary: 'Obtener el detalle de un gasto de importación' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportExpenseResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeImportExpense> {
    return this.importExpensesService.findOne(id, user.role);
  }

  @ApiOperation({
    summary: 'Editar un gasto de importación mientras está DRAFT (solo ADMIN)',
    description:
      'amount/currencyCode adicionalmente bloqueados (409) si el gasto ya tiene lotes de asignación registrados.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportExpenseResponseDto })
  @ApiBadRequestResponse({ description: 'Payload vacío o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'El gasto no está DRAFT, o ya tiene lotes de asignación y se intenta cambiar amount/currencyCode.',
  })
  @Roles(...WRITE_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateImportExpenseDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportExpense> {
    return this.importExpensesService.update({
      importExpenseId: id,
      category: dto.category,
      description: dto.description,
      supplierId: dto.supplierId,
      purchaseInvoiceLineId: dto.purchaseInvoiceLineId,
      documentType: dto.documentType,
      documentReference: dto.documentReference,
      expenseDate: dto.expenseDate,
      currencyCode: dto.currencyCode,
      amount: dto.amount,
      remarks: dto.remarks,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Finalizar un gasto DRAFT (solo ADMIN)',
    description:
      'Cabecera inmutable a partir de aquí; las asignaciones siguen permitidas.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportExpenseResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'El gasto no está DRAFT.' })
  @Roles(...WRITE_ROLES)
  @Post(':id/finalize')
  @HttpCode(HttpStatus.OK)
  finalize(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportExpense> {
    return this.importExpensesService.finalize({
      importExpenseId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Anular un gasto DRAFT o FINALIZED (solo ADMIN)',
    description: 'Bloqueado (409) si ya tiene lotes de asignación registrados.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportExpenseResponseDto })
  @ApiBadRequestResponse({ description: 'reason faltante o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'Ya está CANCELLED, o tiene lotes de asignación.',
  })
  @Roles(...WRITE_ROLES)
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelImportExpenseDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportExpense> {
    return this.importExpensesService.cancel({
      importExpenseId: id,
      reason: dto.reason,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Crear un lote de asignación de costo (solo ADMIN)',
    description:
      'amountToAllocate es SIEMPRE explícito (nunca el monto total del gasto por defecto). QUANTITY/WEIGHT/VOLUME reparten proporcionalmente con residual exacto; MANUAL exige montos explícitos que sumen exactamente amountToAllocate. Nunca excede, junto con lotes previos, ImportExpense.amount. idempotencyKey opcional: reenviarla devuelve el mismo lote.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: ImportExpenseAllocationBatchResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload inválido, línea inexistente/ajena, o falta la medición requerida (WEIGHT/VOLUME).',
  })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'El gasto está CANCELLED, excede el monto disponible, o referencia un embarque CANCELLED.',
  })
  @Roles(...WRITE_ROLES)
  @Post(':id/allocate')
  allocate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AllocateImportExpenseDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeImportExpenseAllocationBatch> {
    return this.importExpensesService.allocate({
      importExpenseId: id,
      method: dto.method,
      amountToAllocate: dto.amountToAllocate,
      shipmentLineIds: dto.shipmentLineIds,
      manualAllocations: dto.manualAllocations,
      idempotencyKey: dto.idempotencyKey,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Previsualizar un reparto de costo, sin persistir nada (lectura)',
    description:
      'Reutiliza EXACTAMENTE el mismo cálculo que allocate(); nunca escribe, nunca audita.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportExpenseAllocationPreviewResponseDto })
  @ApiBadRequestResponse({
    description: 'Payload inválido o falta la medición requerida.',
  })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Post(':id/allocate/preview')
  @HttpCode(HttpStatus.OK)
  previewAllocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AllocateImportExpenseDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{
    method: string;
    requestedAmount: string;
    lines: { importShipmentLineId: string; amount: string }[];
  }> {
    return this.importExpensesService.previewAllocation(
      {
        importExpenseId: id,
        method: dto.method,
        amountToAllocate: dto.amountToAllocate,
        shipmentLineIds: dto.shipmentLineIds,
        manualAllocations: dto.manualAllocations,
      },
      user.role,
    );
  }

  @ApiOperation({
    summary: 'Listar los lotes de asignación de un gasto de importación',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: [ImportExpenseAllocationBatchResponseDto] })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id/allocations')
  listAllocations(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeImportExpenseAllocationBatch[]> {
    return this.importExpensesService.listAllocationBatches(id, user.role);
  }
}
