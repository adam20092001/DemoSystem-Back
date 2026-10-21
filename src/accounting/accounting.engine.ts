import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  Account,
  AccountingEventType,
  AccountingSourceType,
  AccountingSystemKey,
  AccountStatus,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  parseAccountingDateOnly,
  resolveAccountingDateParts,
} from './accounting-period.utils';
import {
  assertLinesBalanced,
  assertValidAccountingDescription,
  buildManualReversalDescription,
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
  PostManualEntryCommand,
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
  journalNumber: true,
  accountingDate: true,
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
    const lines = buildPaymentCollectionLines(
      command.accountingDestination,
      command.amount,
    );

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
   * Contabiliza DEFINITIVAMENTE un borrador de asiento manual (Fase
   * A4.4) — único punto donde un ManualJournalDraft se convierte en una
   * fila real de AccountingEntry. A diferencia de postSaleRecognition/
   * postPaymentCollection:
   *   - Las cuentas se resuelven por `accountId` real (A4.3: el
   *     ACCOUNTANT elige la cuenta directamente del plan de cuentas),
   *     nunca por `systemKey` — ver resolveManualAccounts().
   *   - La fecha contable es la EXPLÍCITA del borrador (A4.4: "use the
   *     explicitly selected accounting date"), nunca derivada de
   *     `postedAt` — ver parseAccountingDateOnly().
   *   - El periodo debe existir y estar OPEN de antemano, salvo que sea
   *     el mes de negocio EN CURSO (mismo criterio de auto-creación ya
   *     usado por el posteo comercial) — ver
   *     resolveOpenPeriodIdForManualEntry(): nunca se crea un periodo
   *     histórico arbitrario a partir de una fecha manual.
   * `sourceId` = `command.draftId`: el índice único parcial
   * accounting_entries_one_original_per_source (migration.sql, sin
   * código nuevo) ya impide por sí solo que un mismo borrador se
   * contabilice dos veces, incluso bajo una carrera que lograra evadir
   * el lock de fila que ManualJournalEntriesService sostiene sobre el
   * borrador.
   */
  async postManualEntry(
    tx: Prisma.TransactionClient,
    command: PostManualEntryCommand,
  ): Promise<PostedAccountingEntry> {
    assertValidAccountingDescription(command.description);

    const existing = await tx.accountingEntry.findFirst({
      where: {
        sourceType: AccountingSourceType.MANUAL,
        sourceId: command.draftId,
        eventType: AccountingEventType.ORIGINAL,
      },
      select: { id: true },
    });
    if (existing !== null) {
      throw new ConflictException(
        'Este borrador ya fue contabilizado anteriormente',
      );
    }

    const accountsById = await this.resolveManualAccounts(
      tx,
      command.lines.map((line) => line.accountId),
    );
    const resolvedLines: ResolvedAccountingLine[] = command.lines.map(
      (line) => ({
        accountId: this.requireManualAccount(accountsById, line.accountId).id,
        debitAmount: line.debitAmount,
        creditAmount: line.creditAmount,
      }),
    );
    // Defensa en profundidad: el servicio llamador (ManualJournalEntriesService)
    // ya valida este mismo cuadre con la misma función, traducido a
    // BadRequestException (400, un error de negocio del ACCOUNTANT) —
    // esto nunca debería fallar aquí; si lo hace, es un invariante
    // interno roto (500), no una entrada de usuario malformada que ya
    // debió rechazarse antes de llegar al motor.
    assertLinesBalanced(resolvedLines);

    const { accountingDate, year, month } = parseAccountingDateOnly(
      command.accountingDateOnly,
    );
    const periodId = await this.resolveOpenPeriodIdForManualEntry(
      tx,
      year,
      month,
    );
    const journalNumber = await this.incrementJournalNumber(
      tx,
      periodId,
      year,
      month,
    );

    const created = await tx.accountingEntry.create({
      data: {
        sourceType: AccountingSourceType.MANUAL,
        sourceId: command.draftId,
        eventType: AccountingEventType.ORIGINAL,
        description: command.description,
        postedAt: new Date(),
        accountingDate,
        periodId,
        journalNumber,
        createdByUserId: command.actorUserId,
        lines: {
          create: resolvedLines.map((line) => ({
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
      action: AuditAction.ACCOUNTING_ENTRY_POSTED,
      entityType: 'AccountingEntry',
      entityId: created.id,
      description: command.description,
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

    // Fase A4.5: MANUAL nunca tiene número de documento — reutiliza la
    // propia descripción del ORIGINAL ya cargado arriba, nunca
    // `command.sourceNumber` (que ManualJournalEntriesService envía
    // vacío para esta rama, al no aplicar).
    const description =
      command.sourceType === AccountingSourceType.SALE
        ? buildSaleReversalDescription(command.sourceNumber)
        : command.sourceType === AccountingSourceType.PAYMENT
          ? buildPaymentReversalDescription(command.sourceNumber)
          : buildManualReversalDescription(original.description);
    assertValidAccountingDescription(description);

    // A2.2: el asiento REVERSAL usa la fecha contable de SU PROPIO
    // postedAt (el instante de la anulación), nunca la del asiento
    // ORIGINAL que revierte — command.postedAt es siempre un instante
    // nuevo generado por el llamador en el momento de anular (ver
    // SalesService.cancel()/PaymentEngine.cancel()), no el postedAt del
    // `original` leído arriba.
    const { accountingDate, periodId, journalNumber } =
      await this.resolvePeriodAndAssignNumber(tx, command.postedAt);

    const created = await tx.accountingEntry.create({
      data: {
        sourceType: command.sourceType,
        sourceId: command.sourceId,
        eventType: AccountingEventType.REVERSAL,
        reversesEntryId: original.id,
        description,
        postedAt: command.postedAt,
        accountingDate,
        periodId,
        journalNumber,
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

    const { accountingDate, periodId, journalNumber } =
      await this.resolvePeriodAndAssignNumber(tx, input.postedAt);

    const created = await tx.accountingEntry.create({
      data: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        eventType: AccountingEventType.ORIGINAL,
        description: input.description,
        postedAt: input.postedAt,
        accountingDate,
        periodId,
        journalNumber,
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
    // A1-review: filtro explícito por status ACTIVE e isPostable=true —
    // defensa en profundidad del motor, nunca confiando únicamente en que
    // la capa de administración (ChartOfAccountsService) ya lo garantizó.
    // Mismo criterio que el resto del dominio (CHECK de base de datos como
    // última línea de defensa aunque el servicio ya valide): si una cuenta
    // de sistema terminara inactiva o no postable por cualquier vía — un
    // bug futuro, un acceso directo a la base, una migración manual — este
    // filtro la excluye de la resolución en vez de postear silenciosamente
    // contra una cuenta inválida; el `for` de abajo la trata entonces como
    // "falta la cuenta requerida" (500 explícito, mismo mensaje y camino
    // que una cuenta de sistema ausente por completo).
    const rows = await tx.account.findMany({
      where: {
        systemKey: { in: uniqueKeys },
        status: AccountStatus.ACTIVE,
        isPostable: true,
      },
    });

    const bySystemKey = new Map<AccountingSystemKey, Account>();
    for (const row of rows) {
      // A1 (PCGE): systemKey es nullable en el schema desde la Fase A1,
      // pero el `where` de arriba (`systemKey: { in: uniqueKeys }`, nunca
      // incluye null) garantiza en runtime que toda fila devuelta tiene un
      // valor — Prisma simplemente no estrecha el tipo según el filtro.
      // Un null aquí sería corrupción de datos, no un caso de negocio.
      if (row.systemKey === null) {
        throw new InternalServerErrorException(
          'Se encontró una cuenta sin systemKey al resolver cuentas de sistema; invariante de datos roto',
        );
      }
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

  // ==================================================================
  // Periodos contables, fecha contable y numeración (Fase A2)
  // ==================================================================

  /**
   * Punto único (A2.4) donde se resuelve el periodo contable de
   * `postedAt`, se valida que esté OPEN y se asigna el siguiente número de
   * asiento DENTRO de ese periodo — todo en un único UPDATE ... RETURNING
   * sobre la fila de AccountingPeriod (mismo patrón exacto que
   * DocumentSequenceService.next()): el propio UPDATE toma el lock de fila
   * y lo mantiene hasta el commit/rollback de `tx`, sin ventana entre leer
   * y escribir. Esto resuelve simultáneamente las dos condiciones de
   * carrera críticas de A2.4:
   *   - Posteo vs. cierre del mismo periodo: si CLOSED ya confirmó cuando
   *     este UPDATE corre, el WHERE status='OPEN' no matchea ninguna fila
   *     (0 RETURNING) y se rechaza con 409; si este UPDATE ya tiene el
   *     lock, el UPDATE de cierre espera hasta que esta transacción
   *     termine, así que un cierre nunca "alcanza" a un asiento que ya
   *     estaba en vuelo.
   *   - Dos posteos simultáneos en el mismo periodo: PostgreSQL serializa
   *     ambos UPDATE sobre la misma fila; cada uno recibe un
   *     lastJournalNumber distinto y consecutivo, nunca duplicado.
   * Si la transacción que llama a este método se revierte, el UPDATE de
   * abajo revierte con ella (es una fila normal, no una secuencia de
   * PostgreSQL): nunca deja huecos en la numeración ya comprometida.
   */
  private async resolvePeriodAndAssignNumber(
    tx: Prisma.TransactionClient,
    postedAt: Date,
  ): Promise<{
    accountingDate: Date;
    periodId: string;
    journalNumber: number;
  }> {
    const { accountingDate, year, month } =
      resolveAccountingDateParts(postedAt);
    const periodId = await this.resolveOrCreateOpenPeriodId(tx, year, month);
    const journalNumber = await this.incrementJournalNumber(
      tx,
      periodId,
      year,
      month,
    );

    return { accountingDate, periodId, journalNumber };
  }

  /**
   * Paso atómico compartido (A2.4/A4.4) de "avanzar el contador de
   * asientos de un periodo ya resuelto, validando que esté OPEN" — único
   * UPDATE ... RETURNING, extraído de resolvePeriodAndAssignNumber() para
   * que postManualEntry() (Fase A4.4) lo reutilice exactamente igual tras
   * resolver su periodo con una regla distinta
   * (resolveOpenPeriodIdForManualEntry(), nunca auto-creación arbitraria
   * de un periodo histórico). Ver el docblock de
   * resolvePeriodAndAssignNumber() para el análisis completo de
   * concurrencia: sigue aplicando sin cambios, el UPDATE es el mismo.
   */
  private async incrementJournalNumber(
    tx: Prisma.TransactionClient,
    periodId: string,
    year: number,
    month: number,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ lastJournalNumber: number }[]>(Prisma.sql`
      UPDATE accounting_periods
      SET last_journal_number = last_journal_number + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${periodId}::uuid AND status = 'OPEN'
      RETURNING last_journal_number AS "lastJournalNumber"
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new ConflictException(
        `No se puede contabilizar: el periodo contable ${year}-${String(month).padStart(2, '0')} está cerrado`,
      );
    }
    return row.lastJournalNumber;
  }

  /**
   * Resuelve el periodo de un asiento MANUAL (Fase A4.4): si ya existe,
   * se usa tal cual (OPEN o CLOSED — es incrementJournalNumber() quien
   * decide si se puede postear). Si NO existe, solo se auto-crea cuando
   * la fecha solicitada cae en el mes de negocio EN CURSO (reutilizando
   * resolveOrCreateOpenPeriodId(), idéntico criterio que un posteo
   * comercial de hoy — nunca una regla paralela). Para cualquier OTRO mes
   * sin periodo todavía, se rechaza explícitamente: A4.4 prohíbe crear
   * automáticamente un periodo histórico arbitrario a partir de una fecha
   * manual; ADMIN debe abrirlo primero (POST /accounting/periods, A2.6).
   */
  private async resolveOpenPeriodIdForManualEntry(
    tx: Prisma.TransactionClient,
    year: number,
    month: number,
  ): Promise<string> {
    const existing = await tx.accountingPeriod.findUnique({
      where: { year_month: { year, month } },
      select: { id: true },
    });
    if (existing !== null) {
      return existing.id;
    }

    const current = resolveAccountingDateParts(new Date());
    if (year === current.year && month === current.month) {
      return this.resolveOrCreateOpenPeriodId(tx, year, month);
    }

    throw new NotFoundException(
      `No existe el periodo contable ${year}-${String(month).padStart(2, '0')}; cree el periodo primero (POST /api/v1/accounting/periods) antes de contabilizar un asiento manual con esa fecha`,
    );
  }

  /**
   * Resuelve cuentas por `accountId` REAL (Fase A4.3/A4.4) — nunca por
   * `systemKey`: un asiento manual referencia la cuenta que el
   * ACCOUNTANT/ADMIN eligió directamente del plan de cuentas. A
   * diferencia de resolveAccounts() (cuentas de SISTEMA, cuya ausencia es
   * corrupción de configuración del servidor, 500), aquí una cuenta
   * inexistente/inactiva/no postable es un error de ENTRADA del usuario:
   * BadRequestException (400), nunca 500.
   */
  private async resolveManualAccounts(
    tx: Prisma.TransactionClient,
    accountIds: string[],
  ): Promise<Map<string, Account>> {
    const uniqueIds = Array.from(new Set(accountIds));
    const rows = await tx.account.findMany({
      where: {
        id: { in: uniqueIds },
        status: AccountStatus.ACTIVE,
        isPostable: true,
      },
    });

    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of uniqueIds) {
      if (!byId.has(id)) {
        throw new BadRequestException(
          `La cuenta ${id} no existe, no está activa o no es postable`,
        );
      }
    }
    return byId;
  }

  private requireManualAccount(
    accounts: Map<string, Account>,
    accountId: string,
  ): Account {
    const account = accounts.get(accountId);
    if (account === undefined) {
      throw new BadRequestException(
        `La cuenta ${accountId} no existe, no está activa o no es postable`,
      );
    }
    return account;
  }

  /**
   * Resuelve el id del periodo (year, month), creándolo como OPEN si
   * todavía no existe (A2.1: "safe automatic creation of the current
   * period as OPEN when an accounting event needs it" — la actividad
   * comercial normal nunca debe bloquearse porque nadie inicializó
   * manualmente el mes vigente). `INSERT ... ON CONFLICT DO NOTHING` es
   * atómico: si dos transacciones intentan crear el mismo (year, month)
   * por primera vez a la vez, una gana el INSERT y la otra simplemente no
   * inserta nada (sin lanzar error ni bloquear), y ambas terminan leyendo
   * el mismo id ya creado por la ganadora. Nunca reabre un periodo CLOSED:
   * si ya existe, se devuelve su id tal cual (OPEN o CLOSED) y es
   * `resolvePeriodAndAssignNumber()` quien decide si se puede postear.
   */
  private async resolveOrCreateOpenPeriodId(
    tx: Prisma.TransactionClient,
    year: number,
    month: number,
  ): Promise<string> {
    const existing = await tx.accountingPeriod.findUnique({
      where: { year_month: { year, month } },
      select: { id: true },
    });
    if (existing !== null) {
      return existing.id;
    }

    const candidateId = randomUUID();
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO accounting_periods (id, year, month, status, last_journal_number, created_at, updated_at)
      VALUES (${candidateId}::uuid, ${year}, ${month}, 'OPEN', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (year, month) DO NOTHING
    `);

    const resolved = await tx.accountingPeriod.findUnique({
      where: { year_month: { year, month } },
      select: { id: true },
    });
    if (resolved === null) {
      throw new InternalServerErrorException(
        `No se pudo resolver ni crear el periodo contable ${year}-${String(month).padStart(2, '0')}`,
      );
    }
    return resolved.id;
  }
}
