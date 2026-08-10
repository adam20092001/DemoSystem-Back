import { Injectable } from '@nestjs/common';
import { SaleStatus } from '@prisma/client';
import { SafeSale, SafeSaleItem } from '../types/safe-sale';

/**
 * Escapa los 5 caracteres HTML peligrosos, con "&" PRIMERO (si no, las
 * entidades insertadas por los reemplazos siguientes se escaparían de
 * nuevo). Único punto de inserción de texto dinámico en el documento: todo
 * string proveniente de la base de datos pasa por aquí antes de
 * interpolarse. Duplicado deliberadamente respecto a QuoteDocumentRenderer
 * (5 líneas): no se extrae un helper compartido para no acoplar los
 * módulos de Ventas y Cotizaciones ni arriesgar la estabilidad de la
 * Fase 5 por una deduplicación menor.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Sin recursos remotos (fuentes/CSS/JS), sin <script>, todo inline. */
const INLINE_CSS = `
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 24px; }
  .notice { font-size: 12px; font-weight: bold; letter-spacing: 0.5px; color: #555; border: 1px solid #999; display: inline-block; padding: 4px 8px; margin-bottom: 12px; }
  .cancelled-banner { font-size: 18px; font-weight: bold; color: #b00020; border: 2px solid #b00020; padding: 8px 12px; margin-bottom: 16px; display: inline-block; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  h2 { font-size: 14px; margin-top: 20px; margin-bottom: 4px; }
  p { margin: 2px 0; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; font-size: 12px; }
  th { background: #f0f0f0; }
  .totals { margin-top: 12px; text-align: right; }
  .totals p { font-size: 13px; }
  .total-final { font-size: 15px; font-weight: bold; }
`;

/**
 * Genera el documento interno NO FISCAL e imprimible de una venta
 * (GET /sales/:id/print). Recibe únicamente el contrato SafeSale ya
 * seguro (snapshots + vendedor/anulador mínimos): nunca consulta la base
 * ni lee Customer/Product en vivo, así que el documento siempre refleja la
 * identidad histórica de la venta, no el estado actual del catálogo/
 * cliente. Deliberadamente NO renderiza:
 * - resumen de pago (paidAmount/balanceDue/paymentStatus): la Fase 6 no
 *   tiene modelo Payment; presentarlos como evidencia de cobro sería
 *   engañoso;
 * - inventoryMovements/stock: información operativa interna, no parte del
 *   documento comercial (mismo criterio que Quote con stockInfo);
 * - motivo de anulación en texto libre (por defecto): no forma parte del
 *   contrato funcional aprobado para el documento impreso;
 * - datos de seguridad de cancelledBy más allá de su identidad mínima ya
 *   segura.
 */
@Injectable()
export class SaleDocumentRenderer {
  render(sale: SafeSale): string {
    const isCancelled = sale.status === SaleStatus.CANCELLED;
    const cancelledBanner = isCancelled
      ? `<div class="cancelled-banner">ANULADA / CANCELLED</div>`
      : '';
    const quoteLine =
      sale.quote !== null
        ? `<p><strong>Cotización de origen:</strong> ${escapeHtml(sale.quote.number)}</p>`
        : '';
    const customerTypeSuffix =
      sale.customerType !== null
        ? ` (${escapeHtml(String(sale.customerType))})`
        : '';
    const documentTypeLine =
      sale.customerDocumentType !== null && sale.customerDocumentNumber !== null
        ? `<p><strong>Documento:</strong> ${escapeHtml(sale.customerDocumentType)} ${escapeHtml(sale.customerDocumentNumber)}</p>`
        : '';
    const addressLine =
      sale.customerAddress !== null
        ? `<p><strong>Dirección:</strong> ${escapeHtml(sale.customerAddress)}</p>`
        : '';

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(sale.number)}</title>
<style>${INLINE_CSS}</style>
</head>
<body>
  <p class="notice">DOCUMENTO INTERNO — NO FISCAL</p>
  ${cancelledBanner}
  <h1>Venta ${escapeHtml(sale.number)}</h1>
  <p><strong>Fecha de confirmación:</strong> ${escapeHtml(sale.confirmedAt.toISOString())}</p>
  <p><strong>Estado:</strong> ${escapeHtml(String(sale.status))}</p>
  <p><strong>Estado de entrega:</strong> ${escapeHtml(String(sale.deliveryStatus))}</p>
  ${quoteLine}

  <h2>Cliente</h2>
  <p><strong>${escapeHtml(sale.customerName)}</strong>${customerTypeSuffix}</p>
  ${documentTypeLine}
  ${addressLine}

  <h2>Vendedor</h2>
  <p>${escapeHtml(sale.seller.firstName)} ${escapeHtml(sale.seller.lastName)} (${escapeHtml(sale.seller.username)})</p>

  <h2>Ítems</h2>
  <table>
    <thead>
      <tr>
        <th>SKU</th>
        <th>Producto</th>
        <th>Unidad</th>
        <th>Cantidad</th>
        <th>Precio unit.</th>
        <th>Total línea</th>
      </tr>
    </thead>
    <tbody>
      ${sale.items.map((item) => this.renderItemRow(item)).join('\n      ')}
    </tbody>
  </table>

  <div class="totals">
    <p>Subtotal: ${escapeHtml(sale.subtotal)}</p>
    <p>Descuento: ${escapeHtml(sale.discountAmount)}</p>
    <p>Impuesto: ${escapeHtml(sale.taxAmount)}</p>
    <p class="total-final">Total: ${escapeHtml(sale.total)}</p>
  </div>
</body>
</html>`;
  }

  private renderItemRow(item: SafeSaleItem): string {
    return `<tr>
        <td>${escapeHtml(item.productSku)}</td>
        <td>${escapeHtml(item.productName)}</td>
        <td>${escapeHtml(item.unitAbbreviation)} (${escapeHtml(item.unitName)})</td>
        <td>${escapeHtml(item.quantity)}</td>
        <td>${escapeHtml(item.unitPrice)}</td>
        <td>${escapeHtml(item.lineTotal)}</td>
      </tr>`;
  }
}
