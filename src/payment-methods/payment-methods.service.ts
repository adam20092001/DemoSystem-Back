import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditMetadataScalar, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { PAYMENT_METHOD_CODE_PATTERN } from './constants/payment-method.constants';
import {
  PAYMENT_METHOD_SAFE_SELECT,
  toSafePaymentMethod,
} from './mappers/payment-method.mapper';
import { CreatePaymentMethodInput } from './types/create-payment-method.input';
import { ListPaymentMethodsQuery } from './types/list-payment-methods.query';
import { SafePaymentMethod } from './types/safe-payment-method';
import { UpdatePaymentMethodInput } from './types/update-payment-method.input';

/**
 * Entidad de auditoría estable: SIEMPRE 'PaymentMethod' — durante el
 * Bloque C2 esto ya era intencional aunque el modelo Prisma todavía se
 * llamaba temporalmente PaymentMethodDefinition (colisión con el entonces
 * vigente enum PaymentMethod, ver schema.prisma); el Bloque C3 (CONTRACT)
 * eliminó ese enum y renombró el modelo Prisma a su nombre final
 * `PaymentMethod`, así que este literal ya coincide también con el nombre
 * del modelo. El histórico de auditoría generado en C2 se sigue leyendo
 * igual: el nombre del modelo siempre fue un detalle de implementación,
 * nunca algo que se filtrara a datos persistentes de auditoría.
 */
const AUDIT_ENTITY_TYPE = 'PaymentMethod';
const AUDIT_MODULE = 'PAYMENT_METHODS';

/**
 * Roles con acceso de lectura (Ticket C, plan de implementación C2): mismo
 * criterio de "falla cerrado ante cualquier rol no contemplado" que el
 * resto del dominio (Configuration/Payments). WAREHOUSE no tiene ningún
 * acceso, igual que en Payments.
 */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.SELLER,
]);

function assertCanReadPaymentMethods(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar los métodos de pago',
    );
  }
}

/**
 * `includeInactive=true` es exclusivamente ADMIN: MANAGEMENT/SELLER lo
 * envían -> 403 explícito, NUNCA se degrada en silencio a la lista activa
 * (comportamiento fail-closed explícito, plan de implementación C2 §5).
 */
function assertCanRequestInactive(requesterRole: RoleName): void {
  if (requesterRole !== RoleName.ADMIN) {
    throw new ForbiddenException(
      'Solo ADMIN puede solicitar métodos de pago inactivos',
    );
  }
}

/** Mismo criterio que assertCanUpdateConfiguration(): único rol autorizado a escribir. */
function assertCanMutatePaymentMethods(requesterRole: RoleName): void {
  if (requesterRole !== RoleName.ADMIN) {
    throw new ForbiddenException(
      'No tiene permisos para administrar métodos de pago',
    );
  }
}

/**
 * trim + mayúsculas, mismo criterio que Category/Unit/Product. La
 * aplicación NUNCA deriva `code` de `name`: son dos entradas independientes
 * del DTO de creación, y `code` nunca vuelve a tocarse después.
 */
function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Segunda línea de defensa (además del @Matches del DTO): mismo criterio
 * defensivo que assertValidPaymentAmountShape en payment-calculator.ts —
 * nunca confía en que la capa HTTP ya validó. Mismo patrón que el CHECK
 * `payment_methods_code_format` de la base de datos (Bloque C1).
 */
function assertValidCodeFormat(code: string): void {
  if (!PAYMENT_METHOD_CODE_PATTERN.test(code)) {
    throw new BadRequestException(
      'code debe tener 2-30 caracteres, iniciar con una letra A-Z y contener solo A-Z, 0-9 o guion bajo',
    );
  }
}

function normalizeName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException('name no puede estar en blanco');
  }
  return trimmed;
}

/**
 * Administración de métodos de pago dinámicos (Ticket C post-MVP, Bloque
 * C2). Desde el Bloque C3 (CONTRACT), cada mutación aquí tiene efecto
 * observable inmediato y sin redeploy sobre PaymentEngine: crear un método
 * `active: true` lo habilita de inmediato para cobros nuevos; desactivarlo
 * lo bloquea (409) para cobros nuevos sin afectar Payments ya registrados;
 * cambiar `requiresReference`/`affectsCashDrawer`/`accountingDestination`
 * cambia el comportamiento de cobros nuevos sin alterar el snapshot de
 * pagos históricos. Esta clase nunca resuelve ni valida un Payment
 * directamente — esa responsabilidad es exclusiva de PaymentEngine
 * (`PaymentMethodReader`, dentro de la misma transacción del cobro).
 */
@Injectable()
export class PaymentMethodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Sin paginación a propósito (mismo criterio que AccountingService.
   * listAccounts(): una lista pequeña y acotada, pensada para poblar un
   * selector del POS directamente). Orden sortOrder ASC, luego name ASC,
   * luego code ASC como desempate final determinista (dos filas nunca
   * comparten sortOrder+name porque `name` es único en la práctica, pero
   * el tercer nivel lo garantiza formalmente sin depender de esa suposición).
   */
  async listPaymentMethods(
    query: ListPaymentMethodsQuery,
    requesterRole: RoleName,
  ): Promise<SafePaymentMethod[]> {
    assertCanReadPaymentMethods(requesterRole);

    const includeInactive = query.includeInactive === true;
    if (includeInactive) {
      assertCanRequestInactive(requesterRole);
    }

    const rows = await this.prisma.paymentMethod.findMany({
      where: includeInactive ? {} : { active: true },
      select: PAYMENT_METHOD_SAFE_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { code: 'asc' }],
    });
    return rows.map(toSafePaymentMethod);
  }

  async createPaymentMethod(
    input: CreatePaymentMethodInput,
  ): Promise<SafePaymentMethod> {
    assertCanMutatePaymentMethods(input.requesterRole);

    const code = normalizeCode(input.code);
    assertValidCodeFormat(code);
    const name = normalizeName(input.name);
    const sortOrder = input.sortOrder ?? 0;
    if (sortOrder < 0) {
      throw new BadRequestException('sortOrder no puede ser negativo');
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.paymentMethod.findUnique({
        where: { code },
        select: { id: true },
      });
      if (existing !== null) {
        throw new ConflictException(
          `Ya existe un método de pago con code "${code}"`,
        );
      }

      const created = await tx.paymentMethod.create({
        data: {
          code,
          name,
          active: true,
          requiresReference: input.requiresReference,
          affectsCashDrawer: input.affectsCashDrawer,
          accountingDestination: input.accountingDestination,
          sortOrder,
        },
        select: PAYMENT_METHOD_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.PAYMENT_METHOD_CREATED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: created.id,
        description: `Método de pago ${code} creado`,
        metadata: {
          code,
          name,
          requiresReference: input.requiresReference,
          affectsCashDrawer: input.affectsCashDrawer,
          accountingDestination: input.accountingDestination,
          sortOrder,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafePaymentMethod(created);
    });
  }

  /**
   * PATCH con semántica de no-op real (mismo criterio que
   * ConfigurationService.updateConfiguration()): un campo solo se marca
   * "cambiado" si su valor normalizado difiere del vigente; si nada cambió
   * de verdad, se devuelve el recurso actual sin escribir ni auditar.
   *
   * Política de acción de auditoría (plan de implementación C2 §13,
   * decisión cerrada): si `active` transiciona en esta misma petición,
   * ACTIVATED/DEACTIVADO es la ÚNICA acción emitida — el resto de los
   * campos cambiados viajan en el metadata de esa misma fila
   * (changedFields/oldValues/newValues), nunca una fila UPDATED adicional
   * para la misma petición. Si `active` no transiciona pero algún otro
   * campo sí, la acción es UPDATED.
   */
  async updatePaymentMethod(
    input: UpdatePaymentMethodInput,
  ): Promise<SafePaymentMethod> {
    assertCanMutatePaymentMethods(input.requesterRole);

    const hasAnyField =
      input.name !== undefined ||
      input.active !== undefined ||
      input.requiresReference !== undefined ||
      input.affectsCashDrawer !== undefined ||
      input.accountingDestination !== undefined ||
      input.sortOrder !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar: name, active, requiresReference, affectsCashDrawer, accountingDestination o sortOrder',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.paymentMethod.findUnique({
        where: { id: input.paymentMethodId },
        select: PAYMENT_METHOD_SAFE_SELECT,
      });
      if (existing === null) {
        throw new NotFoundException('Método de pago no encontrado');
      }

      const data: Prisma.PaymentMethodUpdateInput = {};
      const changedFields: string[] = [];
      const oldValues: Record<string, AuditMetadataScalar> = {};
      const newValues: Record<string, AuditMetadataScalar> = {};

      function markChanged(
        field: string,
        oldValue: AuditMetadataScalar,
        newValue: AuditMetadataScalar,
      ): void {
        changedFields.push(field);
        oldValues[field] = oldValue;
        newValues[field] = newValue;
      }

      if (input.name !== undefined) {
        const name = normalizeName(input.name);
        if (name !== existing.name) {
          data.name = name;
          markChanged('name', existing.name, name);
        }
      }

      if (
        input.requiresReference !== undefined &&
        input.requiresReference !== existing.requiresReference
      ) {
        data.requiresReference = input.requiresReference;
        markChanged(
          'requiresReference',
          existing.requiresReference,
          input.requiresReference,
        );
      }

      if (
        input.affectsCashDrawer !== undefined &&
        input.affectsCashDrawer !== existing.affectsCashDrawer
      ) {
        data.affectsCashDrawer = input.affectsCashDrawer;
        markChanged(
          'affectsCashDrawer',
          existing.affectsCashDrawer,
          input.affectsCashDrawer,
        );
      }

      if (
        input.accountingDestination !== undefined &&
        input.accountingDestination !== existing.accountingDestination
      ) {
        data.accountingDestination = input.accountingDestination;
        markChanged(
          'accountingDestination',
          existing.accountingDestination,
          input.accountingDestination,
        );
      }

      if (
        input.sortOrder !== undefined &&
        input.sortOrder !== existing.sortOrder
      ) {
        if (input.sortOrder < 0) {
          throw new BadRequestException('sortOrder no puede ser negativo');
        }
        data.sortOrder = input.sortOrder;
        markChanged('sortOrder', existing.sortOrder, input.sortOrder);
      }

      // `active` se evalúa al final, nunca dentro del bucle de campos
      // simples: su transición decide la ACCIÓN de auditoría de toda la
      // petición (ver docblock del método), así que necesita resolverse
      // por separado del resto.
      let activeTransitionedTo: boolean | null = null;
      if (input.active !== undefined && input.active !== existing.active) {
        data.active = input.active;
        markChanged('active', existing.active, input.active);
        activeTransitionedTo = input.active;
      }

      if (changedFields.length === 0) {
        return toSafePaymentMethod(existing);
      }

      const updated = await tx.paymentMethod.update({
        where: { id: input.paymentMethodId },
        data,
        select: PAYMENT_METHOD_SAFE_SELECT,
      });

      const action =
        activeTransitionedTo === true
          ? AuditAction.PAYMENT_METHOD_ACTIVATED
          : activeTransitionedTo === false
            ? AuditAction.PAYMENT_METHOD_DEACTIVATED
            : AuditAction.PAYMENT_METHOD_UPDATED;
      const description =
        activeTransitionedTo === true
          ? `Método de pago ${existing.code} activado`
          : activeTransitionedTo === false
            ? `Método de pago ${existing.code} desactivado`
            : `Método de pago ${existing.code} actualizado`;

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: input.paymentMethodId,
        description,
        metadata: { code: existing.code, changedFields, oldValues, newValues },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafePaymentMethod(updated);
    });
  }
}
