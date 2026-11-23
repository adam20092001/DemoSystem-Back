import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { CountriesService } from './countries.service';
import { CountryResponseDto } from './dto/country-response.dto';
import { CreateCountryDto } from './dto/create-country.dto';
import { ListCountriesQueryDto } from './dto/list-countries-query.dto';
import { UpdateCountryDto } from './dto/update-country.dto';
import { SafeCountry } from './types/safe-country';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
  RoleName.PURCHASING,
  RoleName.WAREHOUSE,
  RoleName.SELLER,
] as const;
const CREATE_ROLES = [RoleName.ADMIN, RoleName.PURCHASING] as const;
const MANAGE_ROLES = [RoleName.ADMIN] as const;

/** Catálogo compartido de países (R4). */
@ApiTags('Countries')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('countries')
export class CountriesController {
  constructor(private readonly countriesService: CountriesService) {}

  @ApiOperation({
    summary: 'Listar países (por defecto solo activos; sin paginación)',
    description:
      'Catálogo compartido por todas las sesiones. includeInactive=true incluye los inactivos (consulta histórica).',
  })
  @ApiOkResponse({ type: [CountryResponseDto] })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListCountriesQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<SafeCountry[]> {
    return this.countriesService.list(query, actor.role);
  }

  @ApiOperation({ summary: 'Consultar un país por su código ISO' })
  @ApiParam({ name: 'code', example: 'CN' })
  @ApiOkResponse({ type: CountryResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @Roles(...READ_ROLES)
  @Get(':code')
  findOne(
    @Param('code') code: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<SafeCountry> {
    return this.countriesService.findOne(code, actor.role);
  }

  @ApiOperation({
    summary: 'Registrar un país nuevo (ADMIN, PURCHASING)',
    description:
      'PURCHASING solo registra países nuevos; editar o desactivar es exclusivo de ADMIN.',
  })
  @ApiCreatedResponse({ type: CountryResponseDto })
  @ApiBadRequestResponse({
    description: 'Código o nombre inválidos (errors[] por campo).',
  })
  @ApiConflictResponse({ description: 'Código o nombre ya existente.' })
  @Roles(...CREATE_ROLES)
  @Post()
  create(
    @Body() dto: CreateCountryDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCountry> {
    return this.countriesService.create({
      code: dto.code,
      name: dto.name,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Editar el nombre o confirmar la revisión de un país (solo ADMIN)',
  })
  @ApiParam({ name: 'code', example: 'CN' })
  @ApiOkResponse({ type: CountryResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'Nombre ya usado por otro país.' })
  @Roles(...MANAGE_ROLES)
  @Patch(':code')
  update(
    @Param('code') code: string,
    @Body() dto: UpdateCountryDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCountry> {
    return this.countriesService.update({
      code,
      name: dto.name,
      pendingReview: dto.pendingReview,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Activar un país (solo ADMIN)' })
  @ApiParam({ name: 'code', example: 'CN' })
  @ApiOkResponse({ type: CountryResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'Ya está activo.' })
  @Roles(...MANAGE_ROLES)
  @HttpCode(HttpStatus.OK)
  @Post(':code/activate')
  activate(
    @Param('code') code: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCountry> {
    return this.countriesService.setActive({
      code,
      active: true,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({
    summary: 'Desactivar un país (solo ADMIN)',
    description:
      'No afecta a los documentos históricos que lo usan; solo impide asignarlo a documentos nuevos. Los países nunca se eliminan.',
  })
  @ApiParam({ name: 'code', example: 'CN' })
  @ApiOkResponse({ type: CountryResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'Ya está inactivo.' })
  @Roles(...MANAGE_ROLES)
  @HttpCode(HttpStatus.OK)
  @Post(':code/deactivate')
  deactivate(
    @Param('code') code: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCountry> {
    return this.countriesService.setActive({
      code,
      active: false,
      requesterRole: actor.role,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
