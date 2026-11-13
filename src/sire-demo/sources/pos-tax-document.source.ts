import { Injectable } from '@nestjs/common';
import {
  ElectronicDocumentStatus,
  Prisma,
  PurchaseInvoiceStatus,
  SaleStatus,
} from '@prisma/client';
import {
  endOfBusinessDayExclusiveUtc,
  startOfBusinessDayUtc,
  toPrismaDate,
} from '../../common/date/business-date';
import { PrismaService } from '../../database/prisma.service';
import { periodBounds } from '../core/period';
import { RawRceDocument, RawRvieDocument, SireRegister } from '../core/types';
import {
  PeriodCount,
  RCE_ELIGIBLE_STATUS,
  RVIE_ELIGIBLE_STATUS,
  SourceLoadResult,
  TaxDocumentSource,
} from './tax-document-source';

interface PeriodRow {
  period: string;
  documentCount: number | bigint;
}

/**
 * Origen POS: lectura EXCLUSIVAMENTE de solo lectura sobre ElectronicDocument
 * (RVIE) y PurchaseInvoice (RCE). Nunca escribe, nunca llama a servicios de
 * Ventas/Compras/Contabilidad. Cada carga usa una única transacción
 * REPEATABLE READ (mismo criterio que los reportes contables de A3).
 */
@Injectable()
export class PosTaxDocumentSource implements TaxDocumentSource {
  readonly source = 'POS' as const;

  constructor(private readonly prisma: PrismaService) {}

  async listPeriods(register: SireRegister): Promise<PeriodCount[]> {
    // Conversión a America/Lima en SQL: mismo patrón que la migración A2
    // ((ts AT TIME ZONE 'UTC') AT TIME ZONE 'America/Lima').
    const rows =
      register === 'RVIE'
        ? await this.prisma.$queryRaw<PeriodRow[]>(Prisma.sql`
            SELECT to_char((issued_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Lima', 'YYYYMM') AS period,
                   COUNT(*)::int AS "documentCount"
            FROM electronic_documents
            WHERE status::text = ${RVIE_ELIGIBLE_STATUS}
            GROUP BY 1
            ORDER BY 1`)
        : await this.prisma.$queryRaw<PeriodRow[]>(Prisma.sql`
            SELECT to_char(accounting_date, 'YYYYMM') AS period,
                   COUNT(*)::int AS "documentCount"
            FROM purchase_invoices
            WHERE status::text = ${RCE_ELIGIBLE_STATUS}
            GROUP BY 1
            ORDER BY 1`);
    return rows.map((row) => ({
      period: row.period,
      documentCount: Number(row.documentCount),
    }));
  }

  load(register: SireRegister, period: string): Promise<SourceLoadResult> {
    return register === 'RVIE' ? this.loadRvie(period) : this.loadRce(period);
  }

  private async loadRvie(period: string): Promise<SourceLoadResult> {
    const { first, last } = periodBounds(period);
    const issuedAt = {
      gte: startOfBusinessDayUtc(first),
      lt: endOfBusinessDayExclusiveUtc(last),
    };

    const [rows, notEligibleStatus, salesWithoutFiscalDocument] =
      await this.prisma.$transaction(
        [
          this.prisma.electronicDocument.findMany({
            where: { status: ElectronicDocumentStatus.ACCEPTED, issuedAt },
            orderBy: [
              { documentType: 'asc' },
              { series: 'asc' },
              { number: 'asc' },
            ],
            select: {
              id: true,
              documentType: true,
              series: true,
              number: true,
              status: true,
              providerCode: true,
              issuedAt: true,
              currencyCode: true,
              customerDocumentType: true,
              customerDocumentNumber: true,
              customerName: true,
              taxableBase: true,
              taxAmount: true,
              total: true,
            },
          }),
          this.prisma.electronicDocument.count({
            where: {
              status: { not: ElectronicDocumentStatus.ACCEPTED },
              issuedAt,
            },
          }),
          this.prisma.sale.count({
            where: {
              status: SaleStatus.ACTIVE,
              confirmedAt: issuedAt,
              electronicDocuments: { none: {} },
            },
          }),
        ],
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );

    const documents: RawRvieDocument[] = rows.map((row) => ({
      register: 'RVIE',
      refId: row.id,
      documentType: row.documentType,
      series: row.series,
      number: row.number,
      status: row.status,
      providerCode: row.providerCode,
      issuedAt: row.issuedAt,
      currencyCode: row.currencyCode,
      customerDocumentType: row.customerDocumentType,
      customerDocumentNumber: row.customerDocumentNumber,
      customerName: row.customerName,
      taxableBase: row.taxableBase,
      taxAmount: row.taxAmount,
      total: row.total,
    }));

    return {
      documents,
      excluded: { notEligibleStatus, salesWithoutFiscalDocument },
    };
  }

  private async loadRce(period: string): Promise<SourceLoadResult> {
    const { first, last } = periodBounds(period);
    const accountingDate = {
      gte: toPrismaDate(first),
      lte: toPrismaDate(last),
    };

    const [rows, notEligibleStatus] = await this.prisma.$transaction(
      [
        this.prisma.purchaseInvoice.findMany({
          where: { status: PurchaseInvoiceStatus.CONFIRMED, accountingDate },
          orderBy: [
            { documentType: 'asc' },
            { documentSeries: 'asc' },
            { documentNumber: 'asc' },
          ],
          select: {
            id: true,
            documentType: true,
            documentSeries: true,
            documentNumber: true,
            status: true,
            issueDate: true,
            accountingDate: true,
            currencyCode: true,
            subtotal: true,
            taxAmount: true,
            totalAmount: true,
            supplier: {
              select: {
                documentType: true,
                documentNumber: true,
                legalName: true,
              },
            },
          },
        }),
        this.prisma.purchaseInvoice.count({
          where: {
            status: { not: PurchaseInvoiceStatus.CONFIRMED },
            accountingDate,
          },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const documents: RawRceDocument[] = rows.map((row) => ({
      register: 'RCE',
      refId: row.id,
      documentType: row.documentType,
      documentSeries: row.documentSeries,
      documentNumber: row.documentNumber,
      status: row.status,
      issueDate: row.issueDate,
      accountingDate: row.accountingDate,
      currencyCode: row.currencyCode,
      supplierDocumentType: row.supplier.documentType,
      supplierDocumentNumber: row.supplier.documentNumber,
      supplierLegalName: row.supplier.legalName,
      subtotal: row.subtotal,
      taxAmount: row.taxAmount,
      totalAmount: row.totalAmount,
    }));

    return {
      documents,
      excluded: { notEligibleStatus, salesWithoutFiscalDocument: null },
    };
  }
}
