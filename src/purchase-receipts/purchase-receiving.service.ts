import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PurchaseInvoiceStatus, RoleName } from '@prisma/client';
import { fromPrismaDate } from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import { computeReceiptLineQuantities } from './receipt-line-status';
import {
  ReceivableInvoiceDetail,
  ReceivableInvoiceListItem,
} from './types/receivable-invoice';

const ZERO = new Prisma.Decimal(0);
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * R1: consulta de recepción para almacén. ADMIN/WAREHOUSE (operan la
 * recepción física) y MANAGEMENT/ACCOUNTANT (lectura). PURCHASING y SELLER
 * quedan fuera: PURCHASING consulta recepciones por las rutas existentes de
 * purchase-invoices/purchase-receipts, con vista completa.
 */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
  RoleName.PURCHASING,
]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar facturas pendientes de recepción',
    );
  }
}

interface ReceivableInvoiceIdRow {
  id: string;
  pendingLinesCount: number;
}

interface CountRow {
  total: bigint;
}

/**
 * Vistas de SOLO LECTURA para el almacén (R1). Nunca escribe, nunca toca
 * inventario ni contabilidad, y NUNCA selecciona ni devuelve montos: cada
 * `select` enumera explícitamente solo columnas no financieras.
 *
 * La cantidad pendiente es la misma derivación que el resumen de
 * recepciones de una factura (computeReceiptLineQuantities): facturado
 * menos la suma de recepciones ACTIVE (las CANCELLED no cuentan), solo para
 * líneas `isReceiptEligible = true`, de facturas CONFIRMED.
 */
@Injectable()
export class PurchaseReceivingService {
  constructor(private readonly prisma: PrismaService) {}

  async listReceivableInvoices(
    query: { page?: number; limit?: number },
    requesterRole: RoleName,
  ): Promise<PaginatedResult<ReceivableInvoiceListItem>> {
    assertCanRead(requesterRole);

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
    const offset = (page - 1) * limit;

    // El filtro "tiene al menos una línea elegible con pendiente > 0" se
    // resuelve en SQL para paginar con totales correctos. Misma semántica
    // que computeReceiptLineQuantities: pendiente = facturado - SUM(ACTIVE).
    const pendingCte = Prisma.sql`
      WITH received AS (
        SELECT rl.purchase_invoice_line_id AS line_id,
               SUM(rl.quantity) AS received
        FROM purchase_receipt_lines rl
        JOIN purchase_receipts r ON r.id = rl.purchase_receipt_id
        WHERE r.status = 'ACTIVE'::"PurchaseReceiptStatus"
        GROUP BY rl.purchase_invoice_line_id
      ),
      pending AS (
        SELECT l.purchase_invoice_id AS invoice_id,
               COUNT(*)::int AS pending_lines
        FROM purchase_invoice_lines l
        JOIN purchase_invoices i ON i.id = l.purchase_invoice_id
        LEFT JOIN received rec ON rec.line_id = l.id
        WHERE i.status = 'CONFIRMED'::"PurchaseInvoiceStatus"
          AND l.is_receipt_eligible = true
          AND l.quantity > COALESCE(rec.received, 0)
        GROUP BY l.purchase_invoice_id
      )
    `;

    const [idRows, countRows] = await Promise.all([
      this.prisma.$queryRaw<ReceivableInvoiceIdRow[]>(Prisma.sql`
        ${pendingCte}
        SELECT i.id AS id, p.pending_lines AS "pendingLinesCount"
        FROM pending p
        JOIN purchase_invoices i ON i.id = p.invoice_id
        ORDER BY i.issue_date DESC, i.created_at DESC, i.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `),
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        ${pendingCte}
        SELECT COUNT(*) AS total FROM pending
      `),
    ]);

    const total = Number(countRows[0]?.total ?? 0);
    const ids = idRows.map((r) => r.id);
    const pendingById = new Map(
      idRows.map((r) => [r.id, Number(r.pendingLinesCount)]),
    );

    const invoices =
      ids.length === 0
        ? []
        : await this.prisma.purchaseInvoice.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              documentType: true,
              documentSeries: true,
              documentNumber: true,
              issueDate: true,
              supplier: {
                select: { id: true, legalName: true, tradeName: true },
              },
            },
          });
    const byId = new Map(invoices.map((i) => [i.id, i]));

    const data: ReceivableInvoiceListItem[] = [];
    for (const id of ids) {
      const invoice = byId.get(id);
      if (invoice === undefined) {
        continue;
      }
      data.push({
        id: invoice.id,
        documentType: invoice.documentType,
        documentSeries: invoice.documentSeries,
        documentNumber: invoice.documentNumber,
        issueDate: fromPrismaDate(invoice.issueDate),
        supplier: invoice.supplier,
        pendingLinesCount: pendingById.get(id) ?? 0,
      });
    }

    return {
      data,
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findReceivableInvoice(
    purchaseInvoiceId: string,
    requesterRole: RoleName,
  ): Promise<ReceivableInvoiceDetail> {
    assertCanRead(requesterRole);

    const invoice = await this.prisma.purchaseInvoice.findUnique({
      where: { id: purchaseInvoiceId },
      select: {
        id: true,
        status: true,
        documentType: true,
        documentSeries: true,
        documentNumber: true,
        issueDate: true,
        supplier: { select: { id: true, legalName: true, tradeName: true } },
        lines: {
          where: { isReceiptEligible: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            quantity: true,
            unitCodeSnapshot: true,
            unitNameSnapshot: true,
            product: { select: { id: true, sku: true, name: true } },
          },
        },
      },
    });
    if (invoice === null) {
      throw new NotFoundException('Factura de compra no encontrada');
    }
    if (invoice.status !== PurchaseInvoiceStatus.CONFIRMED) {
      throw new ConflictException(
        'Solo las facturas de compra CONFIRMED admiten recepción de mercadería',
      );
    }

    const receivedSums = await this.prisma.purchaseReceiptLine.groupBy({
      by: ['purchaseInvoiceLineId'],
      where: {
        purchaseInvoiceLineId: { in: invoice.lines.map((l) => l.id) },
        purchaseReceipt: { status: 'ACTIVE' },
      },
      _sum: { quantity: true },
    });
    const receivedMap = new Map(
      receivedSums.map((r) => [
        r.purchaseInvoiceLineId,
        r._sum.quantity ?? ZERO,
      ]),
    );

    const lines = invoice.lines.flatMap((line) => {
      // Una línea elegible siempre tiene producto (invariante congelado al
      // confirmar); si no lo tuviera, se omite en vez de romper la vista.
      if (line.product === null) {
        return [];
      }
      return [
        {
          purchaseInvoiceLineId: line.id,
          productId: line.product.id,
          productSku: line.product.sku,
          productName: line.product.name,
          unitCode: line.unitCodeSnapshot,
          unitName: line.unitNameSnapshot,
          ...computeReceiptLineQuantities(
            receivedMap.get(line.id) ?? ZERO,
            line.quantity,
          ),
        },
      ];
    });

    return {
      id: invoice.id,
      status: invoice.status,
      documentType: invoice.documentType,
      documentSeries: invoice.documentSeries,
      documentNumber: invoice.documentNumber,
      issueDate: fromPrismaDate(invoice.issueDate),
      supplier: invoice.supplier,
      pendingLinesCount: lines.filter((l) => l.status !== 'COMPLETE').length,
      lines,
    };
  }
}
