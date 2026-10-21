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
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { ListSuppliersQueryDto } from './dto/list-suppliers-query.dto';
import {
  PaginatedSuppliersResponseDto,
  SupplierResponseDto,
} from './dto/supplier-response.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { SafeSupplier } from './types/safe-supplier';
import { SuppliersService } from './suppliers.service';

/** ADMIN administra el ciclo de vida completo; MANAGEMENT/ACCOUNTANT solo leen. SELLER/WAREHOUSE sin ningún acceso nuevo (A5.1 kickoff, §6). */
const WRITE_ROLES = [RoleName.ADMIN] as const;
const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
] as const;

/**
 * Maestro de datos de proveedores (Fase A5.1). Sin ningún vínculo a
 * Compras/Cuentas por Pagar (todavía no existen) ni a AccountingEngine: ver
 * CLAUDE.md §11 para el alcance exacto de esta fase.
 */
@ApiTags('Suppliers')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @ApiOperation({ summary: 'Listar proveedores (paginado, con filtros)' })
  @ApiOkResponse({ type: PaginatedSuppliersResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListSuppliersQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeSupplier>> {
    return this.suppliersService.list(query, user.role);
  }

  @ApiOperation({ summary: 'Obtener el detalle de un proveedor' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SupplierResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeSupplier> {
    return this.suppliersService.findOne(id, user.role);
  }

  @ApiOperation({
    summary: 'Crear un proveedor (solo ADMIN; nace ACTIVE)',
    description:
      'documentType=RUC/DNI exige el formato numérico exacto (11/8 dígitos, solo FORMATO — nunca una verificación real contra SUNAT). FOREIGN_TAX_ID/OTHER admiten cualquier texto no vacío, para proveedores extranjeros sin RUC. countryCode por defecto "PE" si se omite.',
  })
  @ApiCreatedResponse({ type: SupplierResponseDto })
  @ApiBadRequestResponse({
    description: 'Payload inválido, o documento con formato incorrecto.',
  })
  @ApiConflictResponse({
    description:
      'Ya existe un proveedor con el mismo documentType+countryCode+documentNumber (insensible a mayúsculas/espacios).',
  })
  @Roles(...WRITE_ROLES)
  @Post()
  create(
    @Body() dto: CreateSupplierDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeSupplier> {
    return this.suppliersService.create({
      documentType: dto.documentType,
      documentNumber: dto.documentNumber,
      countryCode: dto.countryCode,
      legalName: dto.legalName,
      tradeName: dto.tradeName,
      contactName: dto.contactName,
      phone: dto.phone,
      email: dto.email,
      address: dto.address,
      internalNotes: dto.internalNotes,
      defaultCurrencyCode: dto.defaultCurrencyCode,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Actualizar los datos de un proveedor (solo ADMIN)',
    description:
      'status es inmutable aquí (usar activate/deactivate). El par documentType/documentNumber solo puede reemplazarse junto por un valor nuevo (nunca limpiarse: un proveedor siempre exige documento).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SupplierResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload vacío, par de documento incompleto, o documento con formato incorrecto.',
  })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'El nuevo documento colisiona con otro proveedor ya existente.',
  })
  @Roles(...WRITE_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeSupplier> {
    return this.suppliersService.update({
      supplierId: id,
      documentType: dto.documentType,
      documentNumber: dto.documentNumber,
      countryCode: dto.countryCode,
      legalName: dto.legalName,
      tradeName: dto.tradeName,
      contactName: dto.contactName,
      phone: dto.phone,
      email: dto.email,
      address: dto.address,
      internalNotes: dto.internalNotes,
      defaultCurrencyCode: dto.defaultCurrencyCode,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Activar un proveedor (solo ADMIN)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SupplierResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'Ya estaba ACTIVE.' })
  @Roles(...WRITE_ROLES)
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeSupplier> {
    return this.suppliersService.activate({
      supplierId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Desactivar un proveedor (solo ADMIN)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SupplierResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'Ya estaba INACTIVE.' })
  @Roles(...WRITE_ROLES)
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeSupplier> {
    return this.suppliersService.deactivate({
      supplierId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
