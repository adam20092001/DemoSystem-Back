import {
  BadRequestException,
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
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
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
import { CreateProductImageDto } from './dto/create-product-image.dto';
import { CreateProductSpecificationDto } from './dto/create-product-specification.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { ProductImageResponseDto } from './dto/product-image-response.dto';
import { ProductSpecificationResponseDto } from './dto/product-specification-response.dto';
import {
  PaginatedProductsResponseDto,
  ProductDetailResponseDto,
} from './dto/product-response.dto';
import { UpdateProductSpecificationDto } from './dto/update-product-specification.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductImagesService } from './product-images.service';
import { ProductSpecificationsService } from './product-specifications.service';
import { ProductsService } from './products.service';
import { toContentDisposition } from './utils/sanitize-file-name';
import {
  SafeProductDetail,
  SafeProductListItem,
  SafeProductSpecification,
} from './types/safe-product';
import { SafeProductImage } from './types/safe-product-image';

const READ_ROLES = [
  RoleName.ADMIN,
  RoleName.SELLER,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
] as const;

@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly specificationsService: ProductSpecificationsService,
    private readonly imagesService: ProductImagesService,
  ) {}

  @ApiTags('Products')
  @ApiOperation({
    summary: 'Listar productos (paginado, con filtros)',
    description:
      'SELLER siempre ve solo status=ACTIVE, sin importar lo enviado en el filtro.',
  })
  @ApiOkResponse({ type: PaginatedProductsResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query() query: ListProductsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeProductListItem>> {
    return this.productsService.listProducts(query, user.role);
  }

  @ApiTags('Products')
  @ApiOperation({ summary: 'Obtener el detalle de un producto' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  @ApiNotFoundResponse({
    description: 'No existe, o está INACTIVE y el solicitante es SELLER.',
  })
  @Roles(...READ_ROLES)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SafeProductDetail> {
    return this.productsService.findProductById(id, user.role);
  }

  @ApiTags('Products')
  @ApiOperation({
    summary: 'Crear un producto o servicio (nace ACTIVE, stockCurrent="0.000")',
  })
  @ApiCreatedResponse({ type: ProductDetailResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload inválido, o SERVICE con isInventoryTracked/stockMinimum inválidos.',
  })
  @ApiNotFoundResponse({ description: 'categoryId o unitId no existen.' })
  @ApiConflictResponse({
    description: 'SKU duplicado, o categoría/unidad no ACTIVE.',
  })
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

  @ApiTags('Products')
  @ApiOperation({
    summary: 'Actualizar un producto o servicio',
    description:
      'stockCurrent nunca se acepta ni se modifica aquí. Un cambio real de salePrice genera auditoría adicional PRODUCT_PRICE_CHANGED.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  @ApiBadRequestResponse({
    description: 'Payload vacío, o combinación PRODUCT/SERVICE inválida.',
  })
  @ApiNotFoundResponse({
    description: 'No existe, o categoryId/unitId no existen.',
  })
  @ApiConflictResponse({
    description: 'SKU duplicado, o categoría/unidad no ACTIVE.',
  })
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

  @ApiTags('Products')
  @ApiOperation({ summary: 'Activar un producto o servicio' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({
    description: 'Ya está ACTIVE, o su categoría/unidad no está ACTIVE.',
  })
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

  @ApiTags('Products')
  @ApiOperation({ summary: 'Desactivar un producto o servicio' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  @ApiNotFoundResponse({ description: 'No existe.' })
  @ApiConflictResponse({ description: 'Ya está INACTIVE.' })
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

  @ApiTags('Product Specifications')
  @ApiOperation({ summary: 'Agregar una especificación técnica al producto' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'ID del producto' })
  @ApiCreatedResponse({ type: ProductSpecificationResponseDto })
  @ApiBadRequestResponse({ description: 'Payload inválido.' })
  @ApiNotFoundResponse({ description: 'El producto no existe.' })
  @ApiConflictResponse({
    description:
      'Nombre de especificación duplicado (insensible a mayúsculas) en el mismo producto.',
  })
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

  @ApiTags('Product Specifications')
  @ApiOperation({ summary: 'Actualizar una especificación técnica' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'ID del producto' })
  @ApiParam({ name: 'specificationId', format: 'uuid' })
  @ApiOkResponse({ type: ProductSpecificationResponseDto })
  @ApiBadRequestResponse({ description: 'Payload vacío.' })
  @ApiNotFoundResponse({
    description: 'No existe, o pertenece a otro producto.',
  })
  @ApiConflictResponse({
    description:
      'Nombre de especificación duplicado (insensible a mayúsculas).',
  })
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

  @ApiTags('Product Specifications')
  @ApiOperation({ summary: 'Eliminar físicamente una especificación técnica' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'ID del producto' })
  @ApiParam({ name: 'specificationId', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Eliminada sin cuerpo de respuesta.' })
  @ApiNotFoundResponse({
    description: 'No existe, o pertenece a otro producto.',
  })
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

  @ApiTags('Product Images')
  @ApiOperation({
    summary: 'Subir una imagen de producto',
    description:
      'Valida MIME y firma binaria (magic bytes); solo image/jpeg, image/png o image/webp. La primera imagen del producto queda como principal automáticamente.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'ID del producto' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        sortOrder: { type: 'integer', minimum: 0 },
      },
    },
  })
  @ApiCreatedResponse({ type: ProductImageResponseDto })
  @ApiBadRequestResponse({
    description:
      'Archivo ausente, MIME no permitido, o firma binaria inválida/no coincidente.',
  })
  @ApiNotFoundResponse({ description: 'El producto no existe.' })
  @ApiPayloadTooLargeResponse({
    description: 'Excede PRODUCT_IMAGE_MAX_SIZE_BYTES.',
  })
  @Roles(RoleName.ADMIN)
  @Post(':id/images')
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(
    @Param('id', ParseUUIDPipe) productId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: CreateProductImageDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeProductImage> {
    if (!file) {
      throw new BadRequestException('El campo file es obligatorio');
    }
    return this.imagesService.addImage({
      productId,
      file: {
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
        size: file.size,
      },
      sortOrder: dto.sortOrder,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiTags('Product Images')
  @ApiOperation({
    summary: 'Descargar el binario de una imagen de producto',
    description: 'SELLER solo puede descargar imágenes de productos ACTIVE.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'ID del producto' })
  @ApiParam({ name: 'imageId', format: 'uuid' })
  @ApiOkResponse({
    description:
      'Contenido binario de la imagen (Content-Type según el archivo).',
  })
  @ApiNotFoundResponse({
    description:
      'Producto/imagen inexistente, imagen de otro producto, archivo físico ausente, o producto INACTIVE para SELLER.',
  })
  @Roles(...READ_ROLES)
  @Get(':id/images/:imageId/file')
  async downloadImage(
    @Param('id', ParseUUIDPipe) productId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const file = await this.imagesService.openImageFile(
      { productId, imageId },
      user.role,
    );
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename="${toContentDisposition(file.fileName)}"`,
      length: file.fileSize,
    });
  }

  @ApiTags('Product Images')
  @ApiOperation({ summary: 'Establecer una imagen como principal' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'ID del producto' })
  @ApiParam({ name: 'imageId', format: 'uuid' })
  @ApiOkResponse({ type: ProductImageResponseDto })
  @ApiNotFoundResponse({
    description: 'No existe, o pertenece a otro producto.',
  })
  @ApiConflictResponse({ description: 'La imagen ya es la principal.' })
  @Roles(RoleName.ADMIN)
  @Post(':id/images/:imageId/primary')
  @HttpCode(HttpStatus.OK)
  setPrimaryImage(
    @Param('id', ParseUUIDPipe) productId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeProductImage> {
    return this.imagesService.setPrimaryImage({
      productId,
      imageId,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @ApiTags('Product Images')
  @ApiOperation({
    summary: 'Eliminar una imagen de producto',
    description:
      'Si era la principal y quedan otras, promueve automáticamente la siguiente por sortOrder/createdAt.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'ID del producto' })
  @ApiParam({ name: 'imageId', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Eliminada sin cuerpo de respuesta.' })
  @ApiNotFoundResponse({
    description: 'No existe, o pertenece a otro producto.',
  })
  @Roles(RoleName.ADMIN)
  @Delete(':id/images/:imageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeImage(
    @Param('id', ParseUUIDPipe) productId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<void> {
    await this.imagesService.removeImage({
      productId,
      imageId,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
