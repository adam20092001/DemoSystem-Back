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
import { CustomersService } from './customers.service';
import {
  CustomerResponseDto,
  PaginatedCustomersResponseDto,
} from './dto/customer-response.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { SafeCustomer } from './types/safe-customer';

/** ADMIN y SELLER pueden crear/actualizar/convertir; MANAGEMENT solo lee. WAREHOUSE nunca aparece. */
const WRITE_ROLES = [RoleName.ADMIN, RoleName.SELLER] as const;
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.SELLER,
  RoleName.MANAGEMENT,
] as const;

@ApiTags('Customers')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @ApiOperation({
    summary: 'Listar clientes (paginado, con filtros)',
    description:
      'SELLER ve ACTIVE y BLOCKED (nunca INACTIVE; un filtro explícito status=INACTIVE devuelve página vacía). WAREHOUSE no tiene acceso a este endpoint.',
  })
  @ApiOkResponse({ type: PaginatedCustomersResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListCustomersQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeCustomer>> {
    return this.customersService.list(query, user.role);
  }

  @ApiOperation({ summary: 'Obtener el detalle de un cliente' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({
    description: 'No existe, o está INACTIVE y el solicitante es SELLER.',
  })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeCustomer> {
    return this.customersService.findOne(id, user.role);
  }

  @ApiOperation({
    summary: 'Crear un cliente normal (nace ACTIVE)',
    description:
      'Solo cubre clientes normales. El cliente genérico "Público general" (isGeneric=true, code=PUBLIC_GENERAL) es exclusivo del seed protegido y nunca puede crearse por este endpoint.',
  })
  @ApiCreatedResponse({ type: CustomerResponseDto })
  @ApiBadRequestResponse({
    description: 'Payload inválido, o par de documento incompleto.',
  })
  @Roles(...WRITE_ROLES)
  @Post()
  create(
    @Body() dto: CreateCustomerDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCustomer> {
    return this.customersService.create({
      customerType: dto.customerType,
      customerStage: dto.customerStage,
      name: dto.name,
      documentType: dto.documentType,
      documentNumber: dto.documentNumber,
      tradeName: dto.tradeName,
      contactName: dto.contactName,
      email: dto.email,
      phone: dto.phone,
      address: dto.address,
      internalNotes: dto.internalNotes,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Actualizar los datos de contacto/documento de un cliente',
    description:
      'code, customerType, customerStage, status e isGeneric son inmutables aquí. El par documentType/documentNumber se reemplaza o limpia junto (ambos null limpia; ambos con valor lo reemplaza).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiBadRequestResponse({
    description: 'Payload vacío, o par de documento incompleto.',
  })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'El cliente genérico "Público general" no puede modificarse.',
  })
  @Roles(...WRITE_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCustomer> {
    return this.customersService.update({
      customerId: id,
      name: dto.name,
      documentType: dto.documentType,
      documentNumber: dto.documentNumber,
      tradeName: dto.tradeName,
      contactName: dto.contactName,
      email: dto.email,
      phone: dto.phone,
      address: dto.address,
      internalNotes: dto.internalNotes,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Activar un cliente (solo ADMIN)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'No estaba INACTIVE, o es el cliente genérico.',
  })
  @Roles(RoleName.ADMIN)
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCustomer> {
    return this.customersService.activate({
      customerId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Desactivar un cliente (solo ADMIN)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'No estaba ACTIVE, o es el cliente genérico.',
  })
  @Roles(RoleName.ADMIN)
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCustomer> {
    return this.customersService.deactivate({
      customerId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Bloquear un cliente (solo ADMIN)',
    description:
      'Un cliente BLOCKED sigue siendo visible/operable para ventas al contado; el bloqueo de ventas con saldo pendiente es responsabilidad de la Fase 6.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'No estaba ACTIVE, o es el cliente genérico.',
  })
  @Roles(RoleName.ADMIN)
  @Post(':id/block')
  @HttpCode(HttpStatus.OK)
  block(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCustomer> {
    return this.customersService.block({
      customerId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Desbloquear un cliente (solo ADMIN)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'No estaba BLOCKED, o es el cliente genérico.',
  })
  @Roles(RoleName.ADMIN)
  @Post(':id/unblock')
  @HttpCode(HttpStatus.OK)
  unblock(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCustomer> {
    return this.customersService.unblock({
      customerId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Convertir un prospecto en cliente',
    description:
      'Única transición de etapa soportada (PROSPECT -> CUSTOMER); no existe la inversa.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'No estaba PROSPECT, o es el cliente genérico.',
  })
  @Roles(...WRITE_ROLES)
  @Post(':id/convert-to-customer')
  @HttpCode(HttpStatus.OK)
  convertToCustomer(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCustomer> {
    return this.customersService.convertToCustomer({
      customerId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
