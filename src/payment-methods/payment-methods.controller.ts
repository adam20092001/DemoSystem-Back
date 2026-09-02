import {
  Body,
  Controller,
  Get,
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
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import { ListPaymentMethodsQueryDto } from './dto/list-payment-methods-query.dto';
import { PaymentMethodResponseDto } from './dto/payment-method-response.dto';
import { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';
import { PaymentMethodsService } from './payment-methods.service';
import { SafePaymentMethod } from './types/safe-payment-method';

/**
 * Matriz aprobada (Ticket C, plan de implementación C2 §12): lectura para
 * ADMIN/MANAGEMENT/SELLER (los únicos roles con algún interés operativo en
 * los métodos de pago — SELLER/ADMIN los usan para cobrar, MANAGEMENT los
 * lee igual que el resto de Payments/Reports); mutación exclusiva de
 * ADMIN. WAREHOUSE sin ningún acceso, igual que en Payments.
 */
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.SELLER,
] as const;
const MUTATE_ROLES = [RoleName.ADMIN] as const;

@ApiTags('Payment Methods')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('payment-methods')
export class PaymentMethodsController {
  constructor(private readonly paymentMethodsService: PaymentMethodsService) {}

  @ApiOperation({
    summary: 'Listar métodos de pago',
    description:
      'Sin paginación (lista pequeña y acotada, pensada para poblar directamente un selector del POS). Por defecto solo métodos ACTIVE, ordenados sortOrder ASC, name ASC, code ASC. `includeInactive=true` es exclusivo de ADMIN (incluye los legacy migrados en Fase C1, todos inactivos por defecto); MANAGEMENT/SELLER que lo envíen reciben 403 en vez de una degradación silenciosa a la lista activa.',
  })
  @ApiOkResponse({ type: [PaymentMethodResponseDto] })
  @ApiBadRequestResponse({
    description: 'includeInactive con un valor no booleano.',
  })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListPaymentMethodsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafePaymentMethod[]> {
    return this.paymentMethodsService.listPaymentMethods(
      { includeInactive: query.includeInactive },
      user.role,
    );
  }

  @ApiOperation({
    summary: 'Crear un método de pago personalizado (ADMIN)',
    description:
      'Nace `active: true`. `code` es la identidad estable e inmutable (formato ^[A-Z][A-Z0-9_]{1,29}$ tras normalizar a mayúsculas) — nunca editable después de creado. `accountingDestination` decide la cuenta contable de cobro (CASH -> Caja, BANK -> Bancos, Fase 8 sin cuentas nuevas); `affectsCashDrawer` decide si el monto cuenta como efectivo físico para el futuro arqueo de caja (Ticket B); ambos son conceptos independientes entre sí y de `requiresReference`. Bloque C2: crear un método aquí todavía NO lo habilita para registrar cobros — Payment.method sigue usando el enum antiguo hasta el Bloque C3.',
  })
  @ApiCreatedResponse({ type: PaymentMethodResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload inválido: code con formato incorrecto, name en blanco, o sortOrder negativo.',
  })
  @ApiConflictResponse({
    description: 'Ya existe un método de pago con ese code.',
  })
  @Roles(...MUTATE_ROLES)
  @Post()
  create(
    @Body() dto: CreatePaymentMethodDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafePaymentMethod> {
    return this.paymentMethodsService.createPaymentMethod({
      code: dto.code,
      name: dto.name,
      requiresReference: dto.requiresReference,
      affectsCashDrawer: dto.affectsCashDrawer,
      accountingDestination: dto.accountingDestination,
      sortOrder: dto.sortOrder,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary:
      'Actualizar un método de pago, incluida activación/desactivación (ADMIN)',
    description:
      '`code` nunca es editable (ausente de este DTO; el ValidationPipe global tiene forbidNonWhitelisted, así que enviarlo en el body responde 400 en vez de ignorarse en silencio). `active: false` desactiva sin borrar físicamente: el método permanece visible en pagos históricos y con `includeInactive=true`, y deja de ofrecerse para cobros nuevos a partir del Bloque C3. Un PATCH cuyos valores ya coinciden con los vigentes no escribe nada ni genera auditoría (200 con el recurso sin modificar). Activar/desactivar los 4 métodos legacy migrados en el Bloque C1 es técnicamente posible por ADMIN; el Bloque C1 los deja inactivos por defecto.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PaymentMethodResponseDto })
  @ApiBadRequestResponse({
    description: 'Payload vacío, name en blanco, o sortOrder negativo.',
  })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...MUTATE_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentMethodDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafePaymentMethod> {
    return this.paymentMethodsService.updatePaymentMethod({
      paymentMethodId: id,
      name: dto.name,
      active: dto.active,
      requiresReference: dto.requiresReference,
      affectsCashDrawer: dto.affectsCashDrawer,
      accountingDestination: dto.accountingDestination,
      sortOrder: dto.sortOrder,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
