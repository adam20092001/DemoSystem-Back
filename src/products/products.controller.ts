import {
  Body,
  Controller,
  Delete,
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
import { CreateProductSpecificationDto } from './dto/create-product-specification.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { UpdateProductSpecificationDto } from './dto/update-product-specification.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductSpecificationsService } from './product-specifications.service';
import { ProductsService } from './products.service';
import {
  SafeProductDetail,
  SafeProductListItem,
  SafeProductSpecification,
} from './types/safe-product';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.SELLER,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
] as const;

@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly specificationsService: ProductSpecificationsService,
  ) {}

  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListProductsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeProductListItem>> {
    return this.productsService.listProducts(query, user.role);
  }

  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeProductDetail> {
    return this.productsService.findProductById(id, user.role);
  }

  @Roles(RoleName.ADMIN)
  @Post()
  create(
    @Body() dto: CreateProductDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeProductDetail> {
    return this.productsService.createProduct({
      sku: dto.sku,
      name: dto.name,
      brand: dto.brand,
      productType: dto.productType,
      categoryId: dto.categoryId,
      unitId: dto.unitId,
      salePrice: dto.salePrice,
      commercialDescription: dto.commercialDescription,
      internalNotes: dto.internalNotes,
      isInventoryTracked: dto.isInventoryTracked,
      stockMinimum: dto.stockMinimum,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @Roles(RoleName.ADMIN)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeProductDetail> {
    return this.productsService.updateProduct({
      productId: id,
      sku: dto.sku,
      name: dto.name,
      brand: dto.brand,
      productType: dto.productType,
      categoryId: dto.categoryId,
      unitId: dto.unitId,
      salePrice: dto.salePrice,
      commercialDescription: dto.commercialDescription,
      internalNotes: dto.internalNotes,
      isInventoryTracked: dto.isInventoryTracked,
      stockMinimum: dto.stockMinimum,
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
  ): Promise<SafeProductDetail> {
    return this.productsService.activateProduct({
      productId: id,
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
  ): Promise<SafeProductDetail> {
    return this.productsService.deactivateProduct({
      productId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @Roles(RoleName.ADMIN)
  @Post(':id/specifications')
  createSpecification(
    @Param('id', ParseUUIDPipe) productId: string,
    @Body() dto: CreateProductSpecificationDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeProductSpecification> {
    return this.specificationsService.createSpecification({
      productId,
      name: dto.name,
      value: dto.value,
      unit: dto.unit,
      sortOrder: dto.sortOrder,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @Roles(RoleName.ADMIN)
  @Patch(':id/specifications/:specificationId')
  updateSpecification(
    @Param('id', ParseUUIDPipe) productId: string,
    @Param('specificationId', ParseUUIDPipe) specificationId: string,
    @Body() dto: UpdateProductSpecificationDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeProductSpecification> {
    return this.specificationsService.updateSpecification({
      productId,
      specificationId,
      name: dto.name,
      value: dto.value,
      unit: dto.unit,
      sortOrder: dto.sortOrder,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @Roles(RoleName.ADMIN)
  @Delete(':id/specifications/:specificationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSpecification(
    @Param('id', ParseUUIDPipe) productId: string,
    @Param('specificationId', ParseUUIDPipe) specificationId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<void> {
    await this.specificationsService.deleteSpecification({
      productId,
      specificationId,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
