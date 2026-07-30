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
import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaginatedResult } from '../common/types/paginated-result';
import { CategoriesService } from './categories.service';
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

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListCategoriesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeCategory>> {
    return this.categoriesService.listCategories(query, user.role);
  }

  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeCategory> {
    return this.categoriesService.findCategoryById(id, user.role);
  }

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
