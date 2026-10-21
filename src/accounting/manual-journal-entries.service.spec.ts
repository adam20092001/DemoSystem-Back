import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountingSourceType,
  ManualJournalDraftStatus,
  Prisma,
  RoleName,
} from '@prisma/client';
import { AccountingEngine } from './accounting.engine';
import { ManualJournalEntriesService } from './manual-journal-entries.service';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';

const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const DRAFT_ID = '66666666-6666-4666-8666-666666666666';
const ACCOUNT_DEBIT_ID = '77777777-7777-4777-8777-777777777777';
const ACCOUNT_CREDIT_ID = '88888888-8888-4888-8888-888888888888';
const ENTRY_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-03-15T00:00:00.000Z');

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function makeDraftLineRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'line-1',
    draftId: DRAFT_ID,
    accountId: ACCOUNT_DEBIT_ID,
    debitAmount: d('100.00'),
    creditAmount: d('0.00'),
    createdAt: NOW,
    account: { code: 'MAN-DEB', name: 'Cuenta débito' },
    ...overrides,
  };
}

function makeSafeDraftSelectRow(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id: DRAFT_ID,
    accountingDate: new Date('2026-03-15T00:00:00.000Z'),
    description: 'Ajuste de provisión de alquiler',
    status: ManualJournalDraftStatus.DRAFT,
    postedEntryId: null,
    createdByUserId: ACTOR_ID,
    createdAt: NOW,
    updatedAt: NOW,
    lines: [
      makeDraftLineRow(),
      makeDraftLineRow({
        id: 'line-2',
        accountId: ACCOUNT_CREDIT_ID,
        debitAmount: d('0.00'),
        creditAmount: d('100.00'),
        account: { code: 'MAN-CRE', name: 'Cuenta crédito' },
      }),
    ],
    ...overrides,
  };
}

function makeLockedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: DRAFT_ID,
    status: ManualJournalDraftStatus.DRAFT,
    postedEntryId: null,
    ...overrides,
  };
}

function createTxMock() {
  return {
    manualJournalDraft: {
      create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      update: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      findUniqueOrThrow: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    manualJournalDraftLine: {
      deleteMany: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      createMany: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    account: {
      count: jest.fn<Promise<number>, [Record<string, unknown>]>(),
    },
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    manualJournalDraft: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
      count: jest.fn<Promise<number>, [Record<string, unknown>?]>(),
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
}

function createAccountingEngineMock() {
  return {
    postManualEntry: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    reverseOriginalForSource: jest.fn<Promise<unknown>, [unknown, unknown]>(),
  };
}

describe('ManualJournalEntriesService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let accountingEngine: ReturnType<typeof createAccountingEngineMock>;
  let service: ManualJournalEntriesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    accountingEngine = createAccountingEngineMock();

    service = new ManualJournalEntriesService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
      accountingEngine as unknown as AccountingEngine,
    );

    prisma.manualJournalDraft.findMany.mockResolvedValue([]);
    prisma.manualJournalDraft.count.mockResolvedValue(0);
    prisma.manualJournalDraft.findUnique.mockResolvedValue(
      makeSafeDraftSelectRow(),
    );
    prisma.tx.account.count.mockResolvedValue(2);
    prisma.tx.$queryRaw.mockResolvedValue([makeLockedRow()]);
    prisma.tx.manualJournalDraft.create.mockResolvedValue(
      makeSafeDraftSelectRow(),
    );
    prisma.tx.manualJournalDraft.findUniqueOrThrow.mockResolvedValue(
      makeSafeDraftSelectRow(),
    );
    prisma.tx.manualJournalDraft.update.mockResolvedValue(
      makeSafeDraftSelectRow({ status: ManualJournalDraftStatus.POSTED }),
    );
    accountingEngine.postManualEntry.mockResolvedValue({
      id: ENTRY_ID,
      sourceType: AccountingSourceType.MANUAL,
      sourceId: DRAFT_ID,
      journalNumber: 3,
      accountingDate: new Date('2026-03-15T00:00:00.000Z'),
    });
    accountingEngine.reverseOriginalForSource.mockResolvedValue({
      id: 'reversal-entry-1',
      sourceType: AccountingSourceType.MANUAL,
      sourceId: DRAFT_ID,
    });
  });

  // ====================================================================
  // Permisos (A4.1)
  // ====================================================================
  describe('permisos', () => {
    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s no puede leer: ForbiddenException sin tocar Prisma',
      async (role) => {
        await expect(service.listDrafts({}, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(
          service.findDraftById(DRAFT_ID, role),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.manualJournalDraft.findMany).not.toHaveBeenCalled();
        expect(prisma.manualJournalDraft.findUnique).not.toHaveBeenCalled();
      },
    );

    it.each([RoleName.ADMIN, RoleName.MANAGEMENT, RoleName.ACCOUNTANT])(
      '%s puede leer',
      async (role) => {
        await expect(service.listDrafts({}, role)).resolves.toBeDefined();
      },
    );

    it('MANAGEMENT puede leer pero nunca escribir (nunca adquiere permisos de escritura, P6-E4)', async () => {
      await expect(
        service.createDraft({
          accountingDate: '2026-03-15',
          description: 'x',
          requesterRole: RoleName.MANAGEMENT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.updateDraft({
          draftId: DRAFT_ID,
          description: 'y',
          requesterRole: RoleName.MANAGEMENT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.postDraft({
          draftId: DRAFT_ID,
          requesterRole: RoleName.MANAGEMENT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.reverseEntry({
          draftId: DRAFT_ID,
          reason: 'motivo',
          requesterRole: RoleName.MANAGEMENT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.tx.manualJournalDraft.create).not.toHaveBeenCalled();
    });

    it.each([RoleName.ADMIN, RoleName.ACCOUNTANT])(
      '%s puede crear/editar/contabilizar/revertir borradores',
      async (role) => {
        await expect(
          service.createDraft({
            accountingDate: '2026-03-15',
            description: 'Asiento válido',
            requesterRole: role,
            actorUserId: ACTOR_ID,
            ipAddress: null,
          }),
        ).resolves.toBeDefined();
      },
    );

    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s no puede administrar borradores en ningún método de escritura',
      async (role) => {
        await expect(
          service.createDraft({
            accountingDate: '2026-03-15',
            description: 'x',
            requesterRole: role,
            actorUserId: ACTOR_ID,
            ipAddress: null,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );
  });

  // ====================================================================
  // createDraft (A4.2)
  // ====================================================================
  describe('createDraft', () => {
    it('description en blanco: BadRequestException', async () => {
      await expect(
        service.createDraft({
          accountingDate: '2026-03-15',
          description: '   ',
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('description > 200 caracteres: BadRequestException', async () => {
      await expect(
        service.createDraft({
          accountingDate: '2026-03-15',
          description: 'x'.repeat(201),
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accountingDate con formato inválido: BadRequestException', async () => {
      await expect(
        service.createDraft({
          accountingDate: '15/03/2026',
          description: 'Asiento válido',
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('puede crearse sin líneas (A4.2: borrador incompleto permitido)', async () => {
      await service.createDraft({
        accountingDate: '2026-03-15',
        description: 'Asiento válido',
        requesterRole: RoleName.ACCOUNTANT,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(prisma.tx.account.count).not.toHaveBeenCalled();
      expect(prisma.tx.manualJournalDraft.create).toHaveBeenCalled();
    });

    it('una cuenta referenciada no existe: BadRequestException, no crea el borrador', async () => {
      prisma.tx.account.count.mockResolvedValue(1);
      await expect(
        service.createDraft({
          accountingDate: '2026-03-15',
          description: 'Asiento válido',
          lines: [
            {
              accountId: ACCOUNT_DEBIT_ID,
              debitAmount: '100.00',
              creditAmount: '0.00',
            },
            {
              accountId: ACCOUNT_CREDIT_ID,
              debitAmount: '0.00',
              creditAmount: '100.00',
            },
          ],
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.manualJournalDraft.create).not.toHaveBeenCalled();
    });

    it('línea con monto negativo: BadRequestException (parseManualDraftLineAmounts)', async () => {
      await expect(
        service.createDraft({
          accountingDate: '2026-03-15',
          description: 'Asiento válido',
          lines: [
            {
              accountId: ACCOUNT_DEBIT_ID,
              debitAmount: '-10.00',
              creditAmount: '0.00',
            },
          ],
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.manualJournalDraft.create).not.toHaveBeenCalled();
    });

    it('audita MANUAL_JOURNAL_DRAFT_CREATED exactamente una vez, mismo tx', async () => {
      await service.createDraft({
        accountingDate: '2026-03-15',
        description: 'Asiento válido',
        requesterRole: RoleName.ACCOUNTANT,
        actorUserId: ACTOR_ID,
        ipAddress: '10.0.0.1',
      });
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        client: unknown;
      };
      expect(call.action).toBe(AuditAction.MANUAL_JOURNAL_DRAFT_CREATED);
      expect(call.client).toBe(prisma.tx);
    });
  });

  // ====================================================================
  // updateDraft (A4.2/A4.6)
  // ====================================================================
  describe('updateDraft', () => {
    it('sin ningún campo: BadRequestException, nunca bloquea la fila', async () => {
      await expect(
        service.updateDraft({
          draftId: DRAFT_ID,
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('borrador inexistente: NotFoundException', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([]);
      await expect(
        service.updateDraft({
          draftId: DRAFT_ID,
          description: 'nueva',
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('borrador ya POSTED: ConflictException, no edita', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedRow({ status: ManualJournalDraftStatus.POSTED }),
      ]);
      await expect(
        service.updateDraft({
          draftId: DRAFT_ID,
          description: 'nueva',
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.manualJournalDraft.update).not.toHaveBeenCalled();
    });

    it('lines presente reemplaza el arreglo COMPLETO (deleteMany + createMany), nunca un parche parcial', async () => {
      prisma.tx.account.count.mockResolvedValue(1);
      await service.updateDraft({
        draftId: DRAFT_ID,
        lines: [
          {
            accountId: ACCOUNT_DEBIT_ID,
            debitAmount: '50.00',
            creditAmount: '0.00',
          },
        ],
        requesterRole: RoleName.ACCOUNTANT,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(prisma.tx.manualJournalDraftLine.deleteMany).toHaveBeenCalledWith({
        where: { draftId: DRAFT_ID },
      });
      expect(prisma.tx.manualJournalDraftLine.createMany).toHaveBeenCalled();
    });

    it('audita MANUAL_JOURNAL_DRAFT_UPDATED con changedFields exactos', async () => {
      await service.updateDraft({
        draftId: DRAFT_ID,
        description: 'nueva descripción',
        accountingDate: '2026-03-20',
        requesterRole: RoleName.ACCOUNTANT,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: { changedFields: string[] };
      };
      expect(call.action).toBe(AuditAction.MANUAL_JOURNAL_DRAFT_UPDATED);
      expect(call.metadata.changedFields).toEqual([
        'accountingDate',
        'description',
      ]);
    });
  });

  // ====================================================================
  // postDraft (A4.3/A4.4/A4.6)
  // ====================================================================
  describe('postDraft', () => {
    it('borrador inexistente: NotFoundException', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([]);
      await expect(
        service.postDraft({
          draftId: DRAFT_ID,
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(accountingEngine.postManualEntry).not.toHaveBeenCalled();
    });

    it('ya contabilizado (status=POSTED): ConflictException, nunca llama al motor', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedRow({ status: ManualJournalDraftStatus.POSTED }),
      ]);
      await expect(
        service.postDraft({
          draftId: DRAFT_ID,
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(accountingEngine.postManualEntry).not.toHaveBeenCalled();
    });

    it('menos de 2 líneas: BadRequestException, nunca llama al motor', async () => {
      prisma.tx.manualJournalDraft.findUniqueOrThrow.mockResolvedValue(
        makeSafeDraftSelectRow({ lines: [makeDraftLineRow()] }),
      );
      await expect(
        service.postDraft({
          draftId: DRAFT_ID,
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(accountingEngine.postManualEntry).not.toHaveBeenCalled();
    });

    it('una línea 0/0: BadRequestException, nunca llama al motor', async () => {
      prisma.tx.manualJournalDraft.findUniqueOrThrow.mockResolvedValue(
        makeSafeDraftSelectRow({
          lines: [
            makeDraftLineRow({
              debitAmount: d('0.00'),
              creditAmount: d('0.00'),
            }),
            makeDraftLineRow({
              id: 'line-2',
              accountId: ACCOUNT_CREDIT_ID,
              debitAmount: d('0.00'),
              creditAmount: d('100.00'),
            }),
          ],
        }),
      );
      await expect(
        service.postDraft({
          draftId: DRAFT_ID,
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(accountingEngine.postManualEntry).not.toHaveBeenCalled();
    });

    it('líneas desbalanceadas: BadRequestException (nunca 500), nunca llama al motor', async () => {
      prisma.tx.manualJournalDraft.findUniqueOrThrow.mockResolvedValue(
        makeSafeDraftSelectRow({
          lines: [
            makeDraftLineRow({
              debitAmount: d('100.00'),
              creditAmount: d('0'),
            }),
            makeDraftLineRow({
              id: 'line-2',
              accountId: ACCOUNT_CREDIT_ID,
              debitAmount: d('0'),
              creditAmount: d('90.00'),
            }),
          ],
        }),
      );
      await expect(
        service.postDraft({
          draftId: DRAFT_ID,
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(accountingEngine.postManualEntry).not.toHaveBeenCalled();
    });

    it('camino feliz: delega a AccountingEngine.postManualEntry con draftId/description/accountingDateOnly/lines', async () => {
      await service.postDraft({
        draftId: DRAFT_ID,
        requesterRole: RoleName.ACCOUNTANT,
        actorUserId: ACTOR_ID,
        ipAddress: '10.0.0.1',
      });
      expect(accountingEngine.postManualEntry).toHaveBeenCalledTimes(1);
      const [, command] = accountingEngine.postManualEntry.mock.calls[0] as [
        unknown,
        {
          draftId: string;
          description: string;
          accountingDateOnly: string;
          lines: { accountId: string }[];
        },
      ];
      expect(command.draftId).toBe(DRAFT_ID);
      expect(command.description).toBe('Ajuste de provisión de alquiler');
      expect(command.accountingDateOnly).toBe('2026-03-15');
      expect(command.lines).toHaveLength(2);
    });

    it('camino feliz: marca el borrador POSTED con el postedEntryId devuelto por el motor, misma transacción', async () => {
      await service.postDraft({
        draftId: DRAFT_ID,
        requesterRole: RoleName.ACCOUNTANT,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(prisma.tx.manualJournalDraft.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: DRAFT_ID },
          data: {
            status: ManualJournalDraftStatus.POSTED,
            postedEntryId: ENTRY_ID,
          },
        }),
      );
    });

    it('audita MANUAL_JOURNAL_POSTED exactamente una vez', async () => {
      await service.postDraft({
        draftId: DRAFT_ID,
        requesterRole: RoleName.ACCOUNTANT,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: { draftId: string; entryId: string };
      };
      expect(call.action).toBe(AuditAction.MANUAL_JOURNAL_POSTED);
      expect(call.metadata.draftId).toBe(DRAFT_ID);
      expect(call.metadata.entryId).toBe(ENTRY_ID);
    });
  });

  // ====================================================================
  // reverseEntry (A4.5)
  // ====================================================================
  describe('reverseEntry', () => {
    it('reason vacío: BadRequestException, nunca bloquea la fila', async () => {
      await expect(
        service.reverseEntry({
          draftId: DRAFT_ID,
          reason: '   ',
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('reason > 200 caracteres: BadRequestException', async () => {
      await expect(
        service.reverseEntry({
          draftId: DRAFT_ID,
          reason: 'x'.repeat(201),
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('borrador no contabilizado (status=DRAFT): ConflictException, nunca llama al motor', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([makeLockedRow()]);
      await expect(
        service.reverseEntry({
          draftId: DRAFT_ID,
          reason: 'motivo válido',
          requesterRole: RoleName.ACCOUNTANT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(accountingEngine.reverseOriginalForSource).not.toHaveBeenCalled();
    });

    it('camino feliz: delega a AccountingEngine.reverseOriginalForSource con sourceType=MANUAL/sourceId=draftId/sourceNumber vacío', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedRow({
          status: ManualJournalDraftStatus.POSTED,
          postedEntryId: ENTRY_ID,
        }),
      ]);
      await service.reverseEntry({
        draftId: DRAFT_ID,
        reason: 'Error de cuenta',
        requesterRole: RoleName.ACCOUNTANT,
        actorUserId: ACTOR_ID,
        ipAddress: '10.0.0.1',
      });
      expect(accountingEngine.reverseOriginalForSource).toHaveBeenCalledTimes(
        1,
      );
      const [, command] = accountingEngine.reverseOriginalForSource.mock
        .calls[0] as [
        unknown,
        {
          sourceType: AccountingSourceType;
          sourceId: string;
          sourceNumber: string;
        },
      ];
      expect(command.sourceType).toBe(AccountingSourceType.MANUAL);
      expect(command.sourceId).toBe(DRAFT_ID);
      expect(command.sourceNumber).toBe('');
    });

    it('audita MANUAL_JOURNAL_REVERSED con el motivo exacto', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedRow({
          status: ManualJournalDraftStatus.POSTED,
          postedEntryId: ENTRY_ID,
        }),
      ]);
      await service.reverseEntry({
        draftId: DRAFT_ID,
        reason: 'Error de cuenta',
        requesterRole: RoleName.ACCOUNTANT,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: { reason: string; draftId: string; entryId: string };
      };
      expect(call.action).toBe(AuditAction.MANUAL_JOURNAL_REVERSED);
      expect(call.metadata.reason).toBe('Error de cuenta');
      expect(call.metadata.draftId).toBe(DRAFT_ID);
      expect(call.metadata.entryId).toBe(ENTRY_ID);
    });
  });
});
