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
import { CategoriesService } from './categories.service';
import {
  CategoryResponseDto,
  PaginatedCategoriesResponseDto,
} from './dto/category-response.dto';
import { CreateCategoryDto } from './dto/create-category.dto';
import { ListCategoriesQueryDto } from './dto/list-categories-query.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { SafeCategory } from './types/safe-category';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.SELLER,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
] as const;

@ApiTags('Categories')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @ApiOperation({ summary: 'Listar categorías (paginado, con filtros)' })
  @ApiOkResponse({ type: PaginatedCategoriesResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListCategoriesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeCategory>> {
    return this.categoriesService.listCategories(query, user.role);
  }

  @ApiOperation({ summary: 'Obtener el detalle de una categoría' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CategoryResponseDto })
  @ApiNotFoundResponse({
    description: 'No existe, o está INACTIVE y el solicitante es SELLER.',
  })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeCategory> {
    return this.categoriesService.findCategoryById(id, user.role);
  }

  @ApiOperation({ summary: 'Crear una categoría (nace ACTIVE)' })
  @ApiCreatedResponse({ type: CategoryResponseDto })
  @ApiBadRequestResponse({ description: 'Payload inválido.' })
  @ApiConflictResponse({
    description:
      'code duplicado, name duplicado en el mismo nivel, o padre no ACTIVE.',
  })
  @ApiNotFoundResponse({ description: 'parentId no existe.' })
  @Roles(RoleName.ADMIN)
  @Post()
  create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCategory> {
    return this.categoriesService.createCategory({
      code: dto.code,
      name: dto.name,
      description: dto.description,
      parentId: dto.parentId,
      sortOrder: dto.sortOrder,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Actualizar una categoría' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CategoryResponseDto })
  @ApiBadRequestResponse({
    description: 'Payload vacío, auto-padre o ciclo indirecto.',
  })
  @ApiNotFoundResponse({ description: 'No existe, o parentId no existe.' })
  @ApiConflictResponse({
    description: 'code/name duplicado, o padre no ACTIVE.',
  })
  @Roles(RoleName.ADMIN)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCategory> {
    return this.categoriesService.updateCategory({
      categoryId: id,
      code: dto.code,
      name: dto.name,
      description: dto.description,
      parentId: dto.parentId,
      sortOrder: dto.sortOrder,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Activar una categoría' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CategoryResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'Ya está ACTIVE, o su padre no está ACTIVE.',
  })
  @Roles(RoleName.ADMIN)
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCategory> {
    return this.categoriesService.activateCategory({
      categoryId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiOperation({ summary: 'Desactivar una categoría' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CategoryResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description:
      'Ya está INACTIVE, o existen subcategorías/productos ACTIVE dependientes.',
  })
  @Roles(RoleName.ADMIN)
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCategory> {
    return this.categoriesService.deactivateCategory({
      categoryId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
