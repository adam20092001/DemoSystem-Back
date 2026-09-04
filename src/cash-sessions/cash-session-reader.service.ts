import { Injectable } from '@nestjs/common';
import { CashSessionStatus, Prisma } from '@prisma/client';

/**
 * Fila mínima bloqueada de CashSession devuelta por
 * lockUnresolvedForUser() — exactamente los campos que sus dos
 * consumidores (CashSessionsService.close(), PaymentEngine.register())
 * necesitan: id para el UPDATE/vínculo posterior, status para decidir el
 * siguiente paso, openingAmount para el cálculo de efectivo esperado de
 * close(). userId no se expone (el llamador ya lo conoce: es el mismo que
 * pasó como parámetro).
 */
export interface LockedCashSessionRow {
  id: string;
  status: CashSessionStatus;
  openingAmount: Prisma.Decimal;
}

/**
 * Lector/bloqueador angosto de solo lectura del dominio CashSession (Ticket
 * B, Bloque B4 §6). Nace de extraer el `SELECT ... FOR UPDATE` que
 * CashSessionsService.close() ya usaba desde el Bloque B3 — ahora es el
 * ÚNICO lugar del dominio que sabe cómo bloquear "la caja sin resolver de
 * un usuario", para que PaymentEngine.register() (Bloque B4) y
 * CashSessionsService.close() (Bloque B3) compitan por el MISMO lock de
 * fila, nunca por dos consultas SQL redactadas por separado que podrían
 * divergir con el tiempo.
 *
 * Existe como servicio SEPARADO de CashSessionsService a propósito, mismo
 * criterio que PaymentMethodReader frente a PaymentMethodsService: la
 * consulta interna de dominio ("¿este usuario tiene una caja sin resolver
 * bloqueada?") no tiene ningún rol de solicitante que evaluar ni forma
 * HTTP — es una regla de negocio pura, reutilizable desde cualquier
 * transacción del dominio que la necesite. No aplica ninguna autorización:
 * el llamador (PaymentEngine, CashSessionsService) ya resolvió su propia
 * autorización HTTP antes de necesitar este lock.
 *
 * Se exporta desde CashSessionsModule; PaymentsModule lo importa (ver
 * payments.module.ts) sin que CashSessionsModule necesite importar
 * PaymentsModule — la dependencia va en un solo sentido, sin ciclo, mismo
 * precedente que PaymentMethodsModule/PaymentMethodReader.
 */
@Injectable()
export class CashSessionReader {
  /**
   * Bloquea (SELECT ... FOR UPDATE) la caja sin resolver (OPEN o
   * PENDING_APPROVAL) del usuario indicado, dentro de la transacción del
   * llamador. Devuelve null si no existe ninguna — el índice único parcial
   * `cash_sessions_one_unresolved_per_user` garantiza que nunca hay más de
   * una fila candidata. SIEMPRE recibe `tx` explícito: nunca abre su propia
   * transacción ni inyecta PrismaService, para que el lock viva
   * exactamente dentro de la transacción de quien llama (mismo criterio
   * que PaymentMethodReader.findByCode(code, tx)).
   */
  async lockUnresolvedForUser(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<LockedCashSessionRow | null> {
    const rows = await tx.$queryRaw<LockedCashSessionRow[]>(Prisma.sql`
      SELECT id, status, opening_amount AS "openingAmount"
      FROM cash_sessions
      WHERE user_id = ${userId}::uuid
        AND status IN ('OPEN', 'PENDING_APPROVAL')
      FOR UPDATE
    `);
    return rows[0] ?? null;
  }
}
