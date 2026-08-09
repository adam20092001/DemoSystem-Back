import { PrismaService } from '../database/prisma.service';
import { AuditAction } from './audit-action.enum';
import {
  AuditMetadata,
  AuditService,
  PrismaExecutionClient,
  sanitizeAuditMetadata,
} from './audit.service';

function createPrismaMock() {
  return {
    auditLog: { create: jest.fn().mockResolvedValue(undefined) },
  };
}

describe('AuditService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: AuditService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new AuditService(prisma as unknown as PrismaService);
  });

  it('crea un registro con los campos provistos', async () => {
    await service.record({
      userId: 'user-1',
      module: 'USERS',
      action: AuditAction.USER_CREATED,
      entityType: 'User',
      entityId: 'user-2',
      description: 'Usuario creado',
      metadata: { username: 'jdoe' },
      ipAddress: '127.0.0.1',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        module: 'USERS',
        action: AuditAction.USER_CREATED,
        entityType: 'User',
        entityId: 'user-2',
        description: 'Usuario creado',
        metadata: { username: 'jdoe' },
        ipAddress: '127.0.0.1',
      },
    });
  });

  it('acepta un cliente de transacción en lugar de PrismaService', async () => {
    const tx = createPrismaMock();

    await service.record({
      userId: null,
      module: 'USERS',
      action: AuditAction.USER_BLOCKED,
      entityType: 'User',
      description: 'Usuario bloqueado',
      metadata: { username: 'jdoe' },
      client: tx as unknown as PrismaExecutionClient,
    });

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('soporta userId nulo', async () => {
    await service.record({
      userId: null,
      module: 'AUTH',
      action: AuditAction.LOGIN_FAILED,
      entityType: 'User',
      description: 'Intento de login fallido',
      metadata: { reason: 'USER_NOT_FOUND' },
    });

    const [[call]] = prisma.auditLog.create.mock.calls as [
      [{ data: { userId: string | null } }],
    ];
    expect(call.data.userId).toBeNull();
  });

  it('usa entityId y ipAddress nulos cuando no se proveen', async () => {
    await service.record({
      userId: 'user-1',
      module: 'USERS',
      action: AuditAction.USER_UNBLOCKED,
      entityType: 'User',
      description: 'Usuario desbloqueado',
    });

    const [[call]] = prisma.auditLog.create.mock.calls as [
      [{ data: { entityId: unknown; ipAddress: unknown } }],
    ];
    expect(call.data.entityId).toBeNull();
    expect(call.data.ipAddress).toBeNull();
  });
});

describe('sanitizeAuditMetadata', () => {
  it('conserva solo las claves permitidas para la acción', () => {
    const metadata: AuditMetadata = {
      username: 'jdoe',
      email: 'jdoe@demosystem.local',
      roleName: 'SELLER',
    };

    const sanitized = sanitizeAuditMetadata(AuditAction.USER_CREATED, metadata);

    expect(sanitized).toEqual(metadata);
  });

  it.each([
    'password',
    'passwordHash',
    'password_hash',
    'temporaryPassword',
    'token',
    'jwt',
    'cookie',
    'authorization',
    'secret',
  ])(
    'descarta la clave sensible "%s" aunque esté en la lista blanca',
    (key) => {
      // Se fuerza la clave sensible dentro de un objeto igualmente tipado como
      // AuditMetadata, simulando un error de quien llama al servicio.
      const metadata = {
        username: 'jdoe',
        [key]: 'valor-secreto',
      } as AuditMetadata;

      const sanitized = sanitizeAuditMetadata(
        AuditAction.USER_CREATED,
        metadata,
      );

      expect(sanitized).toEqual({ username: 'jdoe' });
      expect(JSON.stringify(sanitized)).not.toContain('valor-secreto');
    },
  );

  it('descarta claves que no pertenecen a la lista blanca de la acción', () => {
    const metadata: AuditMetadata = {
      username: 'jdoe',
      unexpectedField: 'algo',
    };

    const sanitized = sanitizeAuditMetadata(AuditAction.USER_BLOCKED, metadata);

    expect(sanitized).toEqual({ username: 'jdoe' });
  });

  it('no modifica el objeto metadata original', () => {
    const metadata: AuditMetadata = {
      username: 'jdoe',
      password: 'secreta',
    };
    const original = { ...metadata };

    sanitizeAuditMetadata(AuditAction.USER_CREATED, metadata);

    expect(metadata).toEqual(original);
  });

  it('devuelve undefined si no queda ninguna clave permitida', () => {
    const metadata = { password: 'secreta' } as AuditMetadata;

    expect(
      sanitizeAuditMetadata(AuditAction.USER_CREATED, metadata),
    ).toBeUndefined();
  });

  it('devuelve undefined si no se provee metadata', () => {
    expect(
      sanitizeAuditMetadata(AuditAction.USER_CREATED, undefined),
    ).toBeUndefined();
  });

  it.each([
    AuditAction.INVENTORY_INITIAL_BALANCE_CREATED,
    AuditAction.INVENTORY_ENTRY_CREATED,
    AuditAction.INVENTORY_EXIT_CREATED,
    AuditAction.INVENTORY_ADJUSTMENT_IN_CREATED,
    AuditAction.INVENTORY_ADJUSTMENT_OUT_CREATED,
  ])(
    '%s acepta solo las 7 claves de inventario y descarta reason/notes/referenceId',
    (action) => {
      const metadata = {
        movementId: 'movement-1',
        productId: 'product-1',
        quantity: '5.000',
        previousStock: '10.000',
        newStock: '15.000',
        movementType: 'ENTRY',
        origin: 'MANUAL',
        reason: 'motivo sensible',
        notes: 'nota sensible',
        referenceId: 'ref-1',
      } as AuditMetadata;

      const sanitized = sanitizeAuditMetadata(action, metadata);

      expect(sanitized).toEqual({
        movementId: 'movement-1',
        productId: 'product-1',
        quantity: '5.000',
        previousStock: '10.000',
        newStock: '15.000',
        movementType: 'ENTRY',
        origin: 'MANUAL',
      });
    },
  );

  it('CUSTOMER_CREATED conserva customerType/customerStage/documentType y descarta PII', () => {
    const metadata = {
      customerType: 'PERSON',
      customerStage: 'PROSPECT',
      documentType: 'DNI',
      documentNumber: '12345678',
      name: 'Juan Pérez',
      email: 'juan@example.com',
      phone: '999999999',
      internalNotes: 'nota sensible',
    } as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.CUSTOMER_CREATED,
      metadata,
    );

    expect(sanitized).toEqual({
      customerType: 'PERSON',
      customerStage: 'PROSPECT',
      documentType: 'DNI',
    });
  });

  it('CUSTOMER_UPDATED conserva solo updatedFields y descarta PII/desconocidas', () => {
    const metadata = {
      updatedFields: ['name', 'phone'],
      name: 'Juan Pérez',
      phone: '999999999',
      unexpectedField: 'algo',
    } as unknown as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.CUSTOMER_UPDATED,
      metadata,
    );

    expect(sanitized).toEqual({ updatedFields: ['name', 'phone'] });
  });

  it.each([
    AuditAction.CUSTOMER_ACTIVATED,
    AuditAction.CUSTOMER_DEACTIVATED,
    AuditAction.CUSTOMER_BLOCKED,
    AuditAction.CUSTOMER_UNBLOCKED,
  ])('%s conserva solo previousStatus', (action) => {
    const metadata = {
      previousStatus: 'ACTIVE',
      name: 'Juan Pérez',
      documentNumber: '12345678',
    } as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(action, metadata);

    expect(sanitized).toEqual({ previousStatus: 'ACTIVE' });
  });

  it('CUSTOMER_STAGE_CHANGED conserva previousStage y customerStage', () => {
    const metadata = {
      previousStage: 'PROSPECT',
      customerStage: 'CUSTOMER',
      name: 'Juan Pérez',
    } as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.CUSTOMER_STAGE_CHANGED,
      metadata,
    );

    expect(sanitized).toEqual({
      previousStage: 'PROSPECT',
      customerStage: 'CUSTOMER',
    });
  });
});
