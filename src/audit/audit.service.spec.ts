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
      roleNames: ['SELLER'],
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

  it('QUOTE_CREATED conserva quoteNumber/customerId/itemCount y descarta PII', () => {
    const metadata = {
      quoteNumber: 'COT-000001',
      customerId: 'customer-1',
      itemCount: 3,
      customerName: 'Juan Pérez',
      customerDocumentNumber: '12345678',
      customerAddress: 'Av. Siempre Viva 123',
      notes: 'Nota comercial sensible',
      subtotal: '100.00',
      discountAmount: '10.00',
      taxAmount: '0.00',
      total: '90.00',
    } as unknown as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.QUOTE_CREATED,
      metadata,
    );

    expect(sanitized).toEqual({
      quoteNumber: 'COT-000001',
      customerId: 'customer-1',
      itemCount: 3,
    });
  });

  it('QUOTE_UPDATED conserva quoteNumber/updatedFields/itemCount y descarta payload de ítems', () => {
    const metadata = {
      quoteNumber: 'COT-000002',
      updatedFields: ['expirationDate', 'items'],
      itemCount: 2,
      items: [{ productName: 'Producto X', productSku: 'SKU-1' }],
      productName: 'Producto X',
      productSku: 'SKU-1',
      subtotal: '50.00',
    } as unknown as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.QUOTE_UPDATED,
      metadata,
    );

    expect(sanitized).toEqual({
      quoteNumber: 'COT-000002',
      updatedFields: ['expirationDate', 'items'],
      itemCount: 2,
    });
  });

  it.each([AuditAction.QUOTE_ACCEPTED, AuditAction.QUOTE_REJECTED])(
    '%s conserva solo quoteNumber/previousStatus y descarta montos/PII',
    (action) => {
      const metadata = {
        quoteNumber: 'COT-000003',
        previousStatus: 'PENDING',
        customerName: 'Juan Pérez',
        total: '90.00',
        discountAmount: '10.00',
        taxAmount: '0.00',
        subtotal: '100.00',
        unexpectedField: 'algo',
      } as unknown as AuditMetadata;

      const sanitized = sanitizeAuditMetadata(action, metadata);

      expect(sanitized).toEqual({
        quoteNumber: 'COT-000003',
        previousStatus: 'PENDING',
      });
    },
  );

  it('SALE_CONFIRMED (DIRECT) conserva saleNumber/source/itemCount, sin quoteId ni montos/PII', () => {
    const metadata = {
      saleNumber: 'NV-000001',
      source: 'DIRECT',
      itemCount: 2,
      customerName: 'Juan Pérez',
      customerDocumentNumber: '12345678',
      productName: 'Producto X',
      items: [{ productSku: 'SKU-1' }],
      subtotal: '100.00',
      discountAmount: '10.00',
      taxAmount: '0.00',
      total: '90.00',
      paidAmount: '0.00',
      balanceDue: '90.00',
      stockCurrent: '5.000',
      payment: { method: 'CASH' },
    } as unknown as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.SALE_CONFIRMED,
      metadata,
    );

    expect(sanitized).toEqual({
      saleNumber: 'NV-000001',
      source: 'DIRECT',
      itemCount: 2,
    });
  });

  it('SALE_CONFIRMED (QUOTE) conserva quoteId cuando el llamador lo incluye', () => {
    const metadata = {
      saleNumber: 'NV-000002',
      source: 'QUOTE',
      quoteId: 'quote-1',
      itemCount: 1,
      customerAddress: 'Av. Siempre Viva 123',
    } as unknown as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.SALE_CONFIRMED,
      metadata,
    );

    expect(sanitized).toEqual({
      saleNumber: 'NV-000002',
      source: 'QUOTE',
      quoteId: 'quote-1',
      itemCount: 1,
    });
  });

  it('SALE_CANCELLED conserva solo saleNumber/previousStatus, sin el motivo de anulación', () => {
    const metadata = {
      saleNumber: 'NV-000003',
      previousStatus: 'ACTIVE',
      cancellationReason: 'Cliente se arrepintió del pedido',
      notes: 'algo',
      unexpectedField: 'x',
    } as unknown as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.SALE_CANCELLED,
      metadata,
    );

    expect(sanitized).toEqual({
      saleNumber: 'NV-000003',
      previousStatus: 'ACTIVE',
    });
  });

  it('SALE_DELIVERY_STATUS_CHANGED conserva saleNumber/previousDeliveryStatus/deliveryStatus', () => {
    const metadata = {
      saleNumber: 'NV-000004',
      previousDeliveryStatus: 'PENDING',
      deliveryStatus: 'DELIVERED',
      customerName: 'Juan Pérez',
    } as unknown as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.SALE_DELIVERY_STATUS_CHANGED,
      metadata,
    );

    expect(sanitized).toEqual({
      saleNumber: 'NV-000004',
      previousDeliveryStatus: 'PENDING',
      deliveryStatus: 'DELIVERED',
    });
  });

  it('PAYMENT_REGISTERED conserva solo saleId/saleNumber/method, sin amount/reference/PII', () => {
    const metadata = {
      saleId: 'sale-1',
      saleNumber: 'NV-000006',
      method: 'CASH',
      amount: '40.00',
      reference: 'OP-000123',
      customerName: 'Juan Pérez',
      customerDocumentNumber: '12345678',
      paidAmount: '40.00',
      balanceDue: '60.00',
      total: '100.00',
      unexpectedField: 'x',
    } as unknown as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.PAYMENT_REGISTERED,
      metadata,
    );

    expect(sanitized).toEqual({
      saleId: 'sale-1',
      saleNumber: 'NV-000006',
      method: 'CASH',
    });
  });

  it('PAYMENT_CANCELLED conserva solo saleId/saleNumber/previousStatus/cancellationSource, sin cancellationReason/amount/reference', () => {
    const metadata = {
      saleId: 'sale-1',
      saleNumber: 'NV-000007',
      previousStatus: 'ACTIVE',
      cancellationSource: 'MANUAL',
      cancellationReason: 'Motivo interno confidencial',
      amount: '40.00',
      reference: 'OP-000123',
      customerName: 'Juan Pérez',
    } as unknown as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.PAYMENT_CANCELLED,
      metadata,
    );

    expect(sanitized).toEqual({
      saleId: 'sale-1',
      saleNumber: 'NV-000007',
      previousStatus: 'ACTIVE',
      cancellationSource: 'MANUAL',
    });
  });

  it('ACCOUNTING_ENTRY_POSTED conserva solo entryId/sourceType/sourceId/eventType, sin amount/debit/credit/lines/saleNumber/PII', () => {
    const metadata = {
      entryId: 'entry-1',
      sourceType: 'SALE',
      sourceId: 'sale-1',
      eventType: 'ORIGINAL',
      amount: '100.00',
      debit: '100.00',
      credit: '100.00',
      lines: ['AR', 'SALES'],
      saleNumber: 'NV-000001',
      customerName: 'Juan Pérez',
      customerDocumentNumber: '12345678',
      paymentReference: 'OP-000123',
      cancellationReason: 'Motivo interno',
      subtotal: '100.00',
      discountAmount: '0.00',
      taxAmount: '0.00',
      total: '100.00',
      unexpectedField: 'x',
    } as unknown as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.ACCOUNTING_ENTRY_POSTED,
      metadata,
    );

    expect(sanitized).toEqual({
      entryId: 'entry-1',
      sourceType: 'SALE',
      sourceId: 'sale-1',
      eventType: 'ORIGINAL',
    });
  });

  it('ACCOUNTING_ENTRY_REVERSED conserva solo entryId/sourceType/sourceId/eventType, sin amount/debit/credit/lines/saleNumber/PII', () => {
    const metadata = {
      entryId: 'entry-2',
      sourceType: 'PAYMENT',
      sourceId: 'payment-1',
      eventType: 'REVERSAL',
      amount: '40.00',
      debit: '40.00',
      credit: '40.00',
      lines: ['CASH', 'AR'],
      saleNumber: 'NV-000001',
      customerName: 'Juan Pérez',
      paymentReference: 'OP-000123',
      cancellationReason: 'Motivo interno',
      total: '100.00',
      unexpectedField: 'x',
    } as unknown as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.ACCOUNTING_ENTRY_REVERSED,
      metadata,
    );

    expect(sanitized).toEqual({
      entryId: 'entry-2',
      sourceType: 'PAYMENT',
      sourceId: 'payment-1',
      eventType: 'REVERSAL',
    });
  });

  describe('CONFIGURATION_UPDATED (Fase 10, Bloque A: changedFields + oldValues/newValues)', () => {
    it('conserva changedFields/oldValues/newValues de un solo campo', () => {
      const metadata: AuditMetadata = {
        changedFields: ['businessName'],
        oldValues: { businessName: 'Nombre Anterior' },
        newValues: { businessName: 'Nombre Nuevo' },
      };

      const sanitized = sanitizeAuditMetadata(
        AuditAction.CONFIGURATION_UPDATED,
        metadata,
      );

      expect(sanitized).toEqual({
        changedFields: ['businessName'],
        oldValues: { businessName: 'Nombre Anterior' },
        newValues: { businessName: 'Nombre Nuevo' },
      });
    });

    it('conserva únicamente los campos realmente cambiados en un cambio múltiple', () => {
      const metadata: AuditMetadata = {
        changedFields: ['businessName', 'currencyCode'],
        oldValues: { businessName: 'Antes', currencyCode: 'PEN' },
        newValues: { businessName: 'Después', currencyCode: 'USD' },
      };

      const sanitized = sanitizeAuditMetadata(
        AuditAction.CONFIGURATION_UPDATED,
        metadata,
      );

      expect(sanitized).toEqual(metadata);
    });

    it('preserva null como valor nuevo legítimo (limpiar un campo opcional)', () => {
      const metadata: AuditMetadata = {
        changedFields: ['tradeName'],
        oldValues: { tradeName: 'Comercial Demo' },
        newValues: { tradeName: null },
      };

      const sanitized = sanitizeAuditMetadata(
        AuditAction.CONFIGURATION_UPDATED,
        metadata,
      );

      expect(sanitized).toEqual({
        changedFields: ['tradeName'],
        oldValues: { tradeName: 'Comercial Demo' },
        newValues: { tradeName: null },
      });
    });

    it('descarta dentro de oldValues/newValues cualquier clave ausente de changedFields (defensa de última línea)', () => {
      const metadata = {
        changedFields: ['businessName'],
        oldValues: { businessName: 'Antes', taxRate: '10.00' },
        newValues: { businessName: 'Después', taxRate: '18.00' },
      } as unknown as AuditMetadata;

      const sanitized = sanitizeAuditMetadata(
        AuditAction.CONFIGURATION_UPDATED,
        metadata,
      );

      expect(sanitized).toEqual({
        changedFields: ['businessName'],
        oldValues: { businessName: 'Antes' },
        newValues: { businessName: 'Después' },
      });
    });

    it('descarta una clave sensible aunque figure en changedFields (defensa de última línea)', () => {
      const metadata = {
        changedFields: ['businessName', 'password'],
        oldValues: { businessName: 'Antes', password: 'secreta-antes' },
        newValues: { businessName: 'Después', password: 'secreta-despues' },
      } as unknown as AuditMetadata;

      const sanitized = sanitizeAuditMetadata(
        AuditAction.CONFIGURATION_UPDATED,
        metadata,
      );

      expect(sanitized).toEqual({
        changedFields: ['businessName', 'password'],
        oldValues: { businessName: 'Antes' },
        newValues: { businessName: 'Después' },
      });
      expect(JSON.stringify(sanitized)).not.toContain('secreta');
    });

    it('no admite ningún otro campo fuera de changedFields/oldValues/newValues (singleton/id/createdAt/updatedAt/campos aún bloqueados)', () => {
      const metadata = {
        changedFields: ['businessName'],
        oldValues: { businessName: 'Antes' },
        newValues: { businessName: 'Después' },
        singleton: true,
        id: 'settings-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        taxEnabled: true,
        taxRate: '18.00',
        quoteValidityDays: 15,
        maxDiscountPercent: '100.00',
      } as unknown as AuditMetadata;

      const sanitized = sanitizeAuditMetadata(
        AuditAction.CONFIGURATION_UPDATED,
        metadata,
      );

      expect(sanitized).toEqual({
        changedFields: ['businessName'],
        oldValues: { businessName: 'Antes' },
        newValues: { businessName: 'Después' },
      });
    });
  });

  describe('SEQUENCE_UPDATED (Fase 10, Bloque D: documentType + changedFields + oldValues/newValues)', () => {
    it('conserva documentType + changedFields/oldValues/newValues de un solo campo', () => {
      const metadata: AuditMetadata = {
        documentType: 'QUOTE',
        changedFields: ['prefix'],
        oldValues: { prefix: 'COT-' },
        newValues: { prefix: 'Q-' },
      };

      const sanitized = sanitizeAuditMetadata(
        AuditAction.SEQUENCE_UPDATED,
        metadata,
      );

      expect(sanitized).toEqual({
        documentType: 'QUOTE',
        changedFields: ['prefix'],
        oldValues: { prefix: 'COT-' },
        newValues: { prefix: 'Q-' },
      });
    });

    it('conserva un cambio combinado de prefix/padding/currentNumber', () => {
      const metadata: AuditMetadata = {
        documentType: 'SALE',
        changedFields: ['prefix', 'padding', 'currentNumber'],
        oldValues: { prefix: 'NV-', padding: 6, currentNumber: 100 },
        newValues: { prefix: 'V-', padding: 8, currentNumber: 500 },
      };

      const sanitized = sanitizeAuditMetadata(
        AuditAction.SEQUENCE_UPDATED,
        metadata,
      );

      expect(sanitized).toEqual(metadata);
    });

    it('descarta dentro de oldValues/newValues cualquier clave ausente de changedFields (defensa de última línea)', () => {
      const metadata = {
        documentType: 'QUOTE',
        changedFields: ['prefix'],
        oldValues: { prefix: 'COT-', currentNumber: 100 },
        newValues: { prefix: 'Q-', currentNumber: 500 },
      } as unknown as AuditMetadata;

      const sanitized = sanitizeAuditMetadata(
        AuditAction.SEQUENCE_UPDATED,
        metadata,
      );

      expect(sanitized).toEqual({
        documentType: 'QUOTE',
        changedFields: ['prefix'],
        oldValues: { prefix: 'COT-' },
        newValues: { prefix: 'Q-' },
      });
    });

    it('no admite ningún otro campo fuera de documentType/changedFields/oldValues/newValues (id/updatedAt/valor próximo)', () => {
      const metadata = {
        documentType: 'QUOTE',
        changedFields: ['currentNumber'],
        oldValues: { currentNumber: 100 },
        newValues: { currentNumber: 500 },
        id: 'sequence-1',
        updatedAt: '2026-01-02T00:00:00.000Z',
        nextPreview: 'COT-000501',
      } as unknown as AuditMetadata;

      const sanitized = sanitizeAuditMetadata(
        AuditAction.SEQUENCE_UPDATED,
        metadata,
      );

      expect(sanitized).toEqual({
        documentType: 'QUOTE',
        changedFields: ['currentNumber'],
        oldValues: { currentNumber: 100 },
        newValues: { currentNumber: 500 },
      });
    });
  });

  it('QUOTE_CONVERTED conserva solo quoteNumber/saleNumber', () => {
    const metadata = {
      quoteNumber: 'COT-000005',
      saleNumber: 'NV-000005',
      customerName: 'Juan Pérez',
      total: '90.00',
    } as unknown as AuditMetadata;

    const sanitized = sanitizeAuditMetadata(
      AuditAction.QUOTE_CONVERTED,
      metadata,
    );

    expect(sanitized).toEqual({
      quoteNumber: 'COT-000005',
      saleNumber: 'NV-000005',
    });
  });
});
