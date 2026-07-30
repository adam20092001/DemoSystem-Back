import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CategoryStatus,
  Prisma,
  ProductStatus,
  RoleName,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import {
  CATEGORY_SAFE_SELECT,
  toSafeCategory,
} from './mappers/category.mapper';
import { CategoryStatusActionInput } from './types/category-status-action.input';
import { CreateCategoryInput } from './types/create-category.input';
import { ListCategoriesQuery } from './types/list-categories.query';
import { SafeCategory } from './types/safe-category';
import { UpdateCategoryInput } from './types/update-category.input';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Tope defensivo contra jerarquías anormalmente profundas o corruptas. */
const MAX_ANCESTOR_DEPTH = 100;

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async createCategory(input: CreateCategoryInput): Promise<SafeCategory> {
    const code = normalizeCode(input.code);
    const name = input.name.trim();
    const description = normalizeDescription(input.description);

    return this.prisma.$transaction(async (tx) => {
      if (input.parentId !== undefined) {
        await this.assertParentUsable(tx, input.parentId);
      }

      const created = await tx.category.create({
        data: {
          code,
          name,
          description,
          parentId: input.parentId ?? null,
          sortOrder: input.sortOrder ?? 0,
          status: CategoryStatus.ACTIVE,
        },
        select: CATEGORY_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'CATEGORIES',
        action: AuditAction.CATEGORY_CREATED,
        entityType: 'Category',
        entityId: created.id,
        description: `Categoría ${code} creada`,
        metadata: {
          code,
          name,
          ...(created.parentId !== null ? { parentId: created.parentId } : {}),
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeCategory(created);
    });
  }

  async listCategories(
    query: ListCategoriesQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeCategory>> {
    const page =
      query.page !== undefined && query.page > 0
        ? Math.floor(query.page)
        : DEFAULT_PAGE;
    const limit = Math.min(
      query.limit !== undefined && query.limit > 0
        ? Math.floor(query.limit)
        : DEFAULT_LIMIT,
      MAX_LIMIT,
    );
    const skip = (page - 1) * limit;

    const where: Prisma.CategoryWhereInput = {};
    // SELLER solo ve categorías activas, sin importar lo que envíe en status.
    if (requesterRole === RoleName.SELLER) {
      where.status = CategoryStatus.ACTIVE;
    } else if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.parentId !== undefined) {
      where.parentId = query.parentId;
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      where.OR = [
        { code: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.category.findMany({
        where,
        select: CATEGORY_SAFE_SELECT,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.category.count({ where }),
    ]);

    return {
      data: rows.map(toSafeCategory),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findCategoryById(
    id: string,
    requesterRole: RoleName,
  ): Promise<SafeCategory> {
    const category = await this.prisma.category.findUnique({
      where: { id },
      select: CATEGORY_SAFE_SELECT,
    });
    if (category === null) {
      throw new NotFoundException('Categoría no encontrada');
    }
    // Para SELLER, una categoría INACTIVE no existe: mismo 404 que "no existe".
    if (
      requesterRole === RoleName.SELLER &&
      category.status !== CategoryStatus.ACTIVE
    ) {
      throw new NotFoundException('Categoría no encontrada');
    }
    return toSafeCategory(category);
  }

  async updateCategory(input: UpdateCategoryInput): Promise<SafeCategory> {
    const hasAnyField =
      input.code !== undefined ||
      input.name !== undefined ||
      input.description !== undefined ||
      input.parentId !== undefined ||
      input.sortOrder !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar: code, name, description, parentId o sortOrder',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.category.findUnique({
        where: { id: input.categoryId },
        select: { id: true, code: true },
      });
      if (existing === null) {
        throw new NotFoundException('Categoría no encontrada');
      }

      const data: Prisma.CategoryUpdateInput = {};
      const updatedFields: string[] = [];

      if (input.code !== undefined) {
        data.code = normalizeCode(input.code);
        updatedFields.push('code');
      }
      if (input.name !== undefined) {
        data.name = input.name.trim();
        updatedFields.push('name');
      }
      if (input.description !== undefined) {
        data.description = normalizeDescription(input.description);
        updatedFields.push('description');
      }
      if (input.sortOrder !== undefined) {
        data.sortOrder = input.sortOrder;
        updatedFields.push('sortOrder');
      }

      if (input.parentId !== undefined) {
        if (input.parentId === null) {
          data.parent = { disconnect: true };
        } else {
          if (input.parentId === input.categoryId) {
            throw new BadRequestException(
              'Una categoría no puede ser su propio padre',
            );
          }
          await this.assertParentUsable(tx, input.parentId);
          await this.assertNoCycle(tx, input.categoryId, input.parentId);
          data.parent = { connect: { id: input.parentId } };
        }
        updatedFields.push('parentId');
      }

      const updated = await tx.category.update({
        where: { id: input.categoryId },
        data,
        select: CATEGORY_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'CATEGORIES',
        action: AuditAction.CATEGORY_UPDATED,
        entityType: 'Category',
        entityId: input.categoryId,
        description: `Categoría ${existing.code} actualizada`,
        metadata: { updatedFields },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeCategory(updated);
    });
  }

  async activateCategory(
    input: CategoryStatusActionInput,
  ): Promise<SafeCategory> {
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.findUnique({
        where: { id: input.categoryId },
        select: { id: true, code: true, status: true, parentId: true },
      });
      if (category === null) {
        throw new NotFoundException('Categoría no encontrada');
      }
      if (category.status === CategoryStatus.ACTIVE) {
        throw new ConflictException('La categoría ya está activa');
      }

      if (category.parentId !== null) {
        const parent = await tx.category.findUnique({
          where: { id: category.parentId },
          select: { status: true },
        });
        if (parent === null || parent.status !== CategoryStatus.ACTIVE) {
          throw new ConflictException(
            'No es posible activar: la categoría padre no está activa',
          );
        }
      }

      const activated = await tx.category.update({
        where: { id: input.categoryId },
        data: { status: CategoryStatus.ACTIVE },
        select: CATEGORY_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'CATEGORIES',
        action: AuditAction.CATEGORY_ACTIVATED,
        entityType: 'Category',
        entityId: input.categoryId,
        description: `Categoría ${category.code} activada`,
        metadata: { code: category.code },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeCategory(activated);
    });
  }

  async deactivateCategory(
    input: CategoryStatusActionInput,
  ): Promise<SafeCategory> {
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.findUnique({
        where: { id: input.categoryId },
        select: { id: true, code: true, status: true },
      });
      if (category === null) {
        throw new NotFoundException('Categoría no encontrada');
      }
      if (category.status === CategoryStatus.INACTIVE) {
        throw new ConflictException('La categoría ya está inactiva');
      }

      const activeChildren = await tx.category.count({
        where: { parentId: input.categoryId, status: CategoryStatus.ACTIVE },
      });
      if (activeChildren > 0) {
        throw new ConflictException(
          'No es posible desactivar: existen subcategorías activas',
        );
      }

      const activeProducts = await tx.product.count({
        where: { categoryId: input.categoryId, status: ProductStatus.ACTIVE },
      });
      if (activeProducts > 0) {
        throw new ConflictException(
          'No es posible desactivar: existen productos activos en esta categoría',
        );
      }

      const deactivated = await tx.category.update({
        where: { id: input.categoryId },
        data: { status: CategoryStatus.INACTIVE },
        select: CATEGORY_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'CATEGORIES',
        action: AuditAction.CATEGORY_DEACTIVATED,
        entityType: 'Category',
        entityId: input.categoryId,
        description: `Categoría ${category.code} desactivada`,
        metadata: { code: category.code },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeCategory(deactivated);
    });
  }

  /** Rechaza si el padre candidato no existe o no está ACTIVE. */
  private async assertParentUsable(
    tx: Prisma.TransactionClient,
    parentId: string,
  ): Promise<void> {
    const parent = await tx.category.findUnique({
      where: { id: parentId },
      select: { status: true },
    });
    if (parent === null) {
      throw new NotFoundException('La categoría padre no existe');
    }
    if (parent.status !== CategoryStatus.ACTIVE) {
      throw new ConflictException('La categoría padre debe estar activa');
    }
  }

  /**
   * Recorre la cadena de ancestros desde el padre candidato hacia arriba.
   * Si encuentra `targetId` en el camino, asignarlo como padre generaría un
   * ciclo (el candidato es descendiente del objetivo). También rechaza si
   * detecta un ciclo preexistente entre otros nodos, o una cadena
   * anormalmente larga.
   */
  private async assertNoCycle(
    tx: Prisma.TransactionClient,
    targetId: string,
    candidateParentId: string,
  ): Promise<void> {
    const visited = new Set<string>();
    let currentId: string | null = candidateParentId;
    let depth = 0;

    while (currentId !== null) {
      if (currentId === targetId) {
        throw new BadRequestException(
          'No se puede asignar como padre a la propia categoría o a uno de sus descendientes',
        );
      }
      if (visited.has(currentId)) {
        throw new BadRequestException(
          'La jerarquía de categorías está corrupta: se detectó un ciclo existente',
        );
      }
      visited.add(currentId);

      depth += 1;
      if (depth > MAX_ANCESTOR_DEPTH) {
        throw new BadRequestException(
          'La jerarquía de categorías excede la profundidad máxima permitida',
        );
      }

      const row: { parentId: string | null } | null =
        await tx.category.findUnique({
          where: { id: currentId },
          select: { parentId: true },
        });
      currentId = row?.parentId ?? null;
    }
  }
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeDescription(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
