import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  Account,
  AccountingEventType,
  AccountingSourceType,
  AccountingSystemKey,
  Prisma,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  assertLinesBalanced,
  assertValidAccountingDescription,
  buildPaymentCollectionLines,
  buildPaymentOriginalDescription,
  buildPaymentReversalDescription,
  buildSaleOriginalDescription,
  buildSaleRecognitionLines,
  buildSaleReversalDescription,
  hasSaleEconomicActivity,
  invertResolvedLines,
} from './accounting-calculator';
import {
  PostPaymentCollectionCommand,
  PostSaleRecognitionCommand,
  ReverseOriginalForSourceCommand,
} from './types/accounting-command';
import {
  AccountingLineInput,
  ResolvedAccountingLine,
} from './types/accounting-line';
import { PostedAccountingEntry } from './types/posted-accounting-entry';

const ACCOUNTING_ENTRY_RESULT_SELECT = {
  id: true,
  sourceType: true,
  sourceId: true,
  eventType: true,
} satisfies Prisma.AccountingEntrySelect;

/**
 * Único propietario de la escritura de AccountingEntry/AccountingEntryLine
 * y de su AuditLog (mismo criterio que StockMovementEngine/PaymentEngine).
 * Nunca abre transacción propia ni inyecta PrismaService: `tx` es siempre
 * la transacción del llamador (PaymentEngine para el cobro inicial/
 * posterior y sus anulaciones; SalesService para el reconocimiento de
 * venta y su reversión al anular). Resuelve las seis cuentas de sistema
 * fijas exclusivamente por AccountingSystemKey — nunca por nombre ni por
 * UUID hardcodeado (plan final aprobado, §7) — y jamás actualiza
 * Sale.paidAmount/balanceDue/paymentStatus/Payment.status/
 * Product.stockCurrent: es historia financiera aguas abajo, nunca la
 * fuente de verdad de esos campos.
 */
@Injectable()
export class AccountingEngine {
  constructor(private readonly auditService: AuditService) {}

  /**
   * Reconocimiento contable de una venta confirmada. No-op documentado
   * (retorna null, no crea nada) cuando la venta no tiene actividad
   * económica alguna (los cuatro montos en cero) — plan final aprobado,
   * §12/§20/§35. Una venta con descuento total (subtotal>0,
   * discountAmount=subtotal, total=0) SÍ produce un asiento (§36).
   */
  async postSaleRecognition(
    tx: Prisma.TransactionClient,
    command: PostSaleRecognitionCommand,
  ): Promise<PostedAccountingEntry | null> {
    if (
      !hasSaleEconomicActivity(
        command.subtotal,
        command.discountAmount,
        command.taxAmount,
        command.total,
      )
    ) {
      return null;
    }

    const lines = buildSaleRecognitionLines(
      command.subtotal,
      command.discountAmount,
      command.taxAmount,
      command.total,
    );

    return this.postOriginal(tx, {
      sourceType: AccountingSourceType.SALE,
      sourceId: command.saleId,
      description: buildSaleOriginalDescription(command.saleNumber),
      postedAt: command.postedAt,
      actorUserId: command.actorUserId,
      ipAddress: command.ipAddress,
      lines,
    });
  }

  /**
   * Reconocimiento contable de un cobro (pago inicial embebido en la
   * confirmación de una venta, o pago posterior). Ningún Payment de monto
   * 0 puede existir (invariante de la Fase 7), así que este método siempre
   * produce exactamente dos líneas — nunca un no-op.
   */
  async postPaymentCollection(
    tx: Prisma.TransactionClient,
    command: PostPaymentCollectionCommand,
  ): Promise<PostedAccountingEntry> {
    const lines = buildPaymentCollectionLines(command.method, command.amount);

    return this.postOriginal(tx, {
      sourceType: AccountingSourceType.PAYMENT,
      sourceId: command.paymentId,
      description: buildPaymentOriginalDescription(command.saleNumber),
      postedAt: command.postedAt,
      actorUserId: command.actorUserId,
      ipAddress: command.ipAddress,
      lines,
    });
  }

  /**
   * Revierte el asiento ORIGINAL de un evento de negocio (Sale o Payment),
   * identificado por su fuente (sourceType/sourceId) — API orientada a la
   * fuente (plan final aprobado, §22): el llamador nunca necesita conocer
   * ni consultar el id del AccountingEntry de antemano. Si no existe un
   * ORIGINAL para esa fuente, es corrupción de invariante interna (nunca
   * "no hay nada que hacer"): en operación normal prospectiva de la Fase 8
   * todo Payment/Sale con actividad económica tiene su ORIGINAL.
   */
  async reverseOriginalForSource(
    tx: Prisma.TransactionClient,
    command: ReverseOriginalForSourceCommand,
  ): Promise<PostedAccountingEntry> {
    const original = await tx.accountingEntry.findFirst({
      where: {
        sourceType: command.sourceType,
        sourceId: command.sourceId,
        eventType: AccountingEventType.ORIGINAL,
      },
      include: { lines: true },
    });
    if (original === null) {
      throw new InternalServerErrorException(
        'No existe un asiento contable ORIGINAL para este evento de negocio; no se puede revertir',
      );
    }

    const existingReversal = await tx.accountingEntry.findFirst({
      where: { reversesEntryId: original.id },
      select: { id: true },
    });
    if (existingReversal !== null) {
      throw new ConflictException(
        'Este asiento contable ya fue revertido anteriormente',
      );
    }

    const originalLines: ResolvedAccountingLine[] = original.lines.map(
      (line) => ({
        accountId: line.accountId,
        debitAmount: line.debitAmount,
        creditAmount: line.creditAmount,
      }),
    );
    const invertedLines = invertResolvedLines(originalLines);
    assertLinesBalanced(invertedLines);

    const description =
      command.sourceType === AccountingSourceType.SALE
        ? buildSaleReversalDescription(command.sourceNumber)
        : buildPaymentReversalDescription(command.sourceNumber);
    assertValidAccountingDescription(description);

    const created = await tx.accountingEntry.create({
      data: {
        sourceType: command.sourceType,
        sourceId: command.sourceId,
        eventType: AccountingEventType.REVERSAL,
        reversesEntryId: original.id,
        description,
        postedAt: command.postedAt,
        createdByUserId: command.actorUserId,
        lines: {
          create: invertedLines.map((line) => ({
            accountId: line.accountId,
            debitAmount: line.debitAmount,
            creditAmount: line.creditAmount,
          })),
        },
      },
      select: ACCOUNTING_ENTRY_RESULT_SELECT,
    });

    await this.auditService.record({
      userId: command.actorUserId,
      module: 'ACCOUNTING',
      action: AuditAction.ACCOUNTING_ENTRY_REVERSED,
      entityType: 'AccountingEntry',
      entityId: created.id,
      description,
      metadata: {
        entryId: created.id,
        sourceType: created.sourceType,
        sourceId: created.sourceId,
        eventType: created.eventType,
      },
      ipAddress: command.ipAddress,
      client: tx,
    });

    return created;
  }

  // ==================================================================
  // Helpers privados
  // ==================================================================

  /**
   * Operación interna compartida por postSaleRecognition/
   * postPaymentCollection (plan final aprobado, §19): valida descripción y
   * cuadre, verifica duplicidad de ORIGINAL bajo el mismo tx, resuelve las
   * cuentas requeridas por systemKey, crea el asiento + sus líneas, y
   * audita exactamente una vez. Único punto de la clase que hace INSERT en
   * accounting_entries/accounting_entry_lines.
   */
  private async postOriginal(
    tx: Prisma.TransactionClient,
    input: {
      sourceType: AccountingSourceType;
      sourceId: string;
      description: string;
      postedAt: Date;
      actorUserId: string;
      ipAddress: string | null;
      lines: AccountingLineInput[];
    },
  ): Promise<PostedAccountingEntry> {
    assertValidAccountingDescription(input.description);
    assertLinesBalanced(input.lines);

    const existing = await tx.accountingEntry.findFirst({
      where: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        eventType: AccountingEventType.ORIGINAL,
      },
      select: { id: true },
    });
    if (existing !== null) {
      throw new ConflictException(
        'Ya existe un asiento contable ORIGINAL para este evento de negocio',
      );
    }

    const accountsBySystemKey = await this.resolveAccounts(
      tx,
      input.lines.map((line) => line.systemKey),
    );

    const created = await tx.accountingEntry.create({
      data: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        eventType: AccountingEventType.ORIGINAL,
        description: input.description,
        postedAt: input.postedAt,
        createdByUserId: input.actorUserId,
        lines: {
          create: input.lines.map((line) => ({
            accountId: this.requireAccount(accountsBySystemKey, line.systemKey)
              .id,
            debitAmount: line.debitAmount,
            creditAmount: line.creditAmount,
          })),
        },
      },
      select: ACCOUNTING_ENTRY_RESULT_SELECT,
    });

    await this.auditService.record({
      userId: input.actorUserId,
      module: 'ACCOUNTING',
      action: AuditAction.ACCOUNTING_ENTRY_POSTED,
      entityType: 'AccountingEntry',
      entityId: created.id,
      description: input.description,
      metadata: {
        entryId: created.id,
        sourceType: created.sourceType,
        sourceId: created.sourceId,
        eventType: created.eventType,
      },
      ipAddress: input.ipAddress,
      client: tx,
    });

    return created;
  }

  /**
   * Resuelve todas las cuentas de sistema requeridas en una sola consulta
   * bajo el `tx` del llamador (nunca cachea IDs globalmente/estáticamente:
   * pos_db y pos_db_test difieren, y cada transacción debe resolver contra
   * su propio contexto — plan final aprobado, §7). Si falta una cuenta
   * requerida, es corrupción de configuración del servidor: falla con
   * InternalServerErrorException, nunca con un 400 de negocio ni omitiendo
   * la línea en silencio.
   */
  private async resolveAccounts(
    tx: Prisma.TransactionClient,
    systemKeys: AccountingSystemKey[],
  ): Promise<Map<AccountingSystemKey, Account>> {
    const uniqueKeys = Array.from(new Set(systemKeys));
    const rows = await tx.account.findMany({
      where: { systemKey: { in: uniqueKeys } },
    });

    const bySystemKey = new Map<AccountingSystemKey, Account>();
    for (const row of rows) {
      bySystemKey.set(row.systemKey, row);
    }

    for (const key of uniqueKeys) {
      if (!bySystemKey.has(key)) {
        throw new InternalServerErrorException(
          `Falta la cuenta contable de sistema requerida: ${key}`,
        );
      }
    }

    return bySystemKey;
  }

  private requireAccount(
    accounts: Map<AccountingSystemKey, Account>,
    systemKey: AccountingSystemKey,
  ): Account {
    const account = accounts.get(systemKey);
    if (account === undefined) {
      throw new InternalServerErrorException(
        `Falta la cuenta contable de sistema requerida: ${systemKey}`,
      );
    }
    return account;
  }
}
