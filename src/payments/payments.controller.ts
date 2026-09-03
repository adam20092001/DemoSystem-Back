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
import { CancelPaymentDto } from './dto/cancel-payment.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ListPaymentsQueryDto } from './dto/list-payments-query.dto';
import {
  PaginatedPaymentsResponseDto,
  PaymentMutationResponseDto,
} from './dto/payment-response.dto';
import { PaymentsService } from './payments.service';
import { PaymentMutationResult } from './types/payment-result';
import { SafePayment } from './types/safe-payment';

/**
 * Matriz aprobada (Documento Maestro §7 + plan de la Fase 7): SELLER
 * registra pagos pero nunca los anula (solo ADMIN, mismo criterio que la
 * anulación de venta en Sales). WAREHOUSE no tiene ningún acceso.
 */
const REGISTER_ROLES = [RoleName.ADMIN, RoleName.SELLER] as const;
const CANCEL_ROLES = [RoleName.ADMIN] as const;
const LIST_ROLES = [
  RoleName.ADMIN,
  RoleName.SELLER,
  RoleName.MANAGEMENT,
] as const;

@ApiTags('Payments')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller()
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @ApiOperation({
    summary: 'Registrar un pago posterior sobre una venta existente',
    description:
      'Pago completo o parcial (Documento Maestro §16). El saldo pendiente se calcula en vivo bajo bloqueo de la venta: el monto nunca puede superar el saldo disponible en ese instante. La elegibilidad depende únicamente de que la venta esté ACTIVE — el estado actual del cliente (incluso INACTIVE o BLOCKED) nunca impide cobrar una deuda existente. El resumen de pago de la venta (paidAmount/balanceDue/paymentStatus) se recalcula desde la suma de todos los pagos ACTIVE, nunca con aritmética incremental. `method` (Ticket C, Bloque C3) es un código de método de pago dinámico (ver GET /payment-methods), resuelto dentro de la misma transacción que crea el pago: debe existir y estar activo.',
  })
  @ApiParam({ name: 'saleId', format: 'uuid' })
  @ApiCreatedResponse({ type: PaymentMutationResponseDto })
  @ApiBadRequestResponse({
    description:
      'Monto no positivo o mal formado, method con formato inválido, o falta la referencia obligatoria para el método resuelto (requiresReference=true, ver GET /payment-methods).',
  })
  @ApiNotFoundResponse({
    description:
      'La venta no existe, o method no corresponde a ningún método de pago existente.',
  })
  @ApiConflictResponse({
    description:
      'La venta está anulada, el monto supera el saldo pendiente vigente (incluido el caso de saldo ya en 0), o method corresponde a un método de pago actualmente inactivo.',
  })
  @Roles(...REGISTER_ROLES)
  @Post('sales/:saleId/payments')
  register(
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Body() dto: CreatePaymentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<PaymentMutationResult> {
    return this.paymentsService.register({
      saleId,
      method: dto.method,
      amount: dto.amount,
      reference: dto.reference,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Anular manualmente un pago (solo ADMIN)',
    description:
      'El pago nunca se elimina físicamente: pasa a CANCELLED con motivo obligatorio. El resumen de pago de la venta se recalcula desde los pagos ACTIVE restantes. Una venta a Público general nunca admite la anulación individual de uno de sus pagos (su saldo pendiente debe permanecer siempre en 0): en ese caso, anule la venta completa en su lugar. El estado actual del cliente (incluido BLOCKED) nunca se consulta para esta operación.',
  })
  @ApiParam({ name: 'saleId', format: 'uuid' })
  @ApiParam({ name: 'paymentId', format: 'uuid' })
  @ApiOkResponse({ type: PaymentMutationResponseDto })
  @ApiBadRequestResponse({
    description: 'Motivo de anulación ausente, vacío o demasiado largo.',
  })
  @ApiNotFoundResponse({
    description:
      'La venta no existe, o el pago no existe o no pertenece a esa venta.',
  })
  @ApiConflictResponse({
    description:
      'La venta está anulada, el pago ya está anulado, o la venta es a Público general.',
  })
  @Roles(...CANCEL_ROLES)
  @Post('sales/:saleId/payments/:paymentId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: CancelPaymentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<PaymentMutationResult> {
    return this.paymentsService.cancel({
      saleId,
      paymentId,
      reason: dto.reason,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Listar pagos (paginado, con filtros)',
    description:
      'SELLER tiene acceso Total (sin restricción de propiedad). Incluye pagos ACTIVE y CANCELLED. Los filtros paidFrom/paidTo usan fechas de negocio America/Lima.',
  })
  @ApiOkResponse({ type: PaginatedPaymentsResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros o rango de fechas inválido.' })
  @Roles(...LIST_ROLES)
  @Get('payments')
  list(
    @Query() query: ListPaymentsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafePayment>> {
    return this.paymentsService.list(query, user.role);
  }
}
