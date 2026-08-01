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
import { CreateUnitDto } from './dto/create-unit.dto';
import { ListUnitsQueryDto } from './dto/list-units-query.dto';
import {
  PaginatedUnitsResponseDto,
  UnitResponseDto,
} from './dto/unit-response.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
import { SafeUnit } from './types/safe-unit';
import { UnitsService } from './units.service';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.SELLER,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
] as const;

@ApiTags('Units')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('units')
export class UnitsController {
  constructor(private readonly unitsService: UnitsService) {}

  @ApiOperation({
    summary: 'Listar unidades de medida (paginado, con filtros)',
  })
  @ApiOkResponse({ type: PaginatedUnitsResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListUnitsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeUnit>> {
    return this.unitsService.listUnits(query, user.role);
  }

  @ApiOperation({ summary: 'Obtener el detalle de una unidad' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: UnitResponseDto })
  @ApiNotFoundResponse({
    description: 'No existe, o está INACTIVE y el solicitante es SELLER.',
  })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeUnit> {
    return this.unitsService.findUnitById(id, user.role);
  }

  @ApiOperation({ summary: 'Crear una unidad de medida (nace ACTIVE)' })
  @ApiCreatedResponse({ type: UnitResponseDto })
  @ApiBadRequestResponse({ description: 'Payload inválido.' })
  @ApiConflictResponse({ description: 'code duplicado.' })
  @Roles(RoleName.ADMIN)
  @Post()
  create(
    @Body() dto: CreateUnitDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeUnit> {
    return this.unitsService.createUnit({
      code: dto.code,
      name: dto.name,
      abbreviation: dto.abbreviation,
      allowDecimal: dto.allowDecimal,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Actualizar una unidad de medida' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: UnitResponseDto })
  @ApiBadRequestResponse({ description: 'Payload vacío.' })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'code duplicado.' })
  @Roles(RoleName.ADMIN)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUnitDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeUnit> {
    return this.unitsService.updateUnit({
      unitId: id,
      code: dto.code,
      name: dto.name,
      abbreviation: dto.abbreviation,
      allowDecimal: dto.allowDecimal,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Activar una unidad de medida' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: UnitResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'Ya está ACTIVE.' })
  @Roles(RoleName.ADMIN)
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeUnit> {
    return this.unitsService.activateUnit({
      unitId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Desactivar una unidad de medida' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: UnitResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'Ya está INACTIVE, o existen productos ACTIVE con esta unidad.',
  })
  @Roles(RoleName.ADMIN)
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeUnit> {
    return this.unitsService.deactivateUnit({
      unitId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
