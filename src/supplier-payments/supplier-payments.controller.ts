import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { CancelSupplierPaymentDto } from './dto/cancel-supplier-payment.dto';
import { CreateSupplierPaymentDto } from './dto/create-supplier-payment.dto';
import { ListSupplierPaymentsQueryDto } from './dto/list-supplier-payments-query.dto';
import {
  PaginatedSupplierPaymentsResponseDto,
  SupplierPaymentResponseDto,
} from './dto/supplier-payment-response.dto';
import { SupplierPaymentsService } from './supplier-payments.service';
import { SafeSupplierPayment } from './types/safe-supplier-payment';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;
const MANAGE_ROLES = [RoleName.ADMIN] as const;

/** Registro, consulta, listado y anulación de pagos a proveedores (Fase A5.3). */
@ApiTags('Supplier Payments')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('supplier-payments')
export class SupplierPaymentsController {
  constructor(
    private readonly supplierPaymentsService: SupplierPaymentsService,
  ) {}

  @ApiOperation({
    summary: 'Listar pagos a proveedores (paginado, con filtros)',
  })
  @ApiOkResponse({ type: PaginatedSupplierPaymentsResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListSupplierPaymentsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeSupplierPayment>> {
    return this.supplierPaymentsService.list(query, user.role);
  }

  @ApiOperation({ summary: 'Obtener el detalle de un pago a proveedor' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SupplierPaymentResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeSupplierPayment> {
    return this.supplierPaymentsService.findOne(id, user.role);
  }

  @ApiOperation({
    summary: 'Registrar un pago a proveedor (ADMIN)',
    description:
      'Distribuible entre una o varias facturas CONFIRMED del MISMO proveedor. La suma de allocations[].amount debe ser exactamente igual a amount. El saldo pendiente de cada factura se recalcula bajo bloqueo en el instante del pago. Debita la(s) cuenta(s) de pasivo REALMENTE acreditadas en el/los asiento(s) originales de cada factura (nunca el mapeo vigente de ACCOUNTS_PAYABLE). `idempotencyKey` opcional: reenviarla en un reintento devuelve el mismo pago ya creado.',
  })
  @ApiCreatedResponse({ type: SupplierPaymentResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload inválido, factura inexistente/de otro proveedor, o la suma de allocations no coincide con amount.',
  })
  @ApiNotFoundResponse({
    description:
      'El proveedor no existe, o method no corresponde a ningún método de pago existente.',
  })
  @ApiConflictResponse({
    description:
      'Alguna factura no está CONFIRMED, el monto asignado supera su saldo pendiente, moneda distinta a la vigente, o method inactivo.',
  })
  @Roles(...MANAGE_ROLES)
  @Post()
  create(
    @Body() dto: CreateSupplierPaymentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeSupplierPayment> {
    return this.supplierPaymentsService.create({
      supplierId: dto.supplierId,
      paymentDate: dto.paymentDate,
      amount: dto.amount,
      method: dto.method,
      reference: dto.reference,
      idempotencyKey: dto.idempotencyKey,
      allocations: dto.allocations,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Anular un pago a proveedor ya ACTIVE (ADMIN)',
    description:
      'Revierte exactamente el asiento contable original vía AccountingEngine. Libera automáticamente el saldo asignado (las asignaciones de un pago CANCELLED quedan excluidas de todo cálculo de saldo pendiente).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SupplierPaymentResponseDto })
  @ApiBadRequestResponse({ description: 'reason faltante o inválido.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'El pago no está ACTIVE.' })
  @Roles(...MANAGE_ROLES)
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelSupplierPaymentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeSupplierPayment> {
    return this.supplierPaymentsService.cancel({
      supplierPaymentId: id,
      reason: dto.reason,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
