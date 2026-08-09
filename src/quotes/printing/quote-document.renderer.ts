import { Injectable } from '@nestjs/common';
import { SafeQuote, SafeQuoteItem } from '../types/safe-quote';

/**
 * Escapa los 5 caracteres HTML peligrosos, con "&" PRIMERO (si no, las
 * entidades insertadas por los reemplazos siguientes se escaparían de
 * nuevo). Único punto de inserción de texto dinámico en el documento: todo
 * string proveniente de la base de datos pasa por aquí antes de
 * interpolarse.
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
 * Genera un documento HTML simple e imprimible (GET /quotes/:id/print).
 * Recibe únicamente el contrato SafeQuote ya seguro (snapshots + vendedor
 * mínimo): nunca consulta la base ni lee Customer/Product en vivo, así que
 * el documento siempre refleja la identidad histórica de la cotización, no
 * el estado actual del catálogo/cliente. stockInfo llega dentro de
 * SafeQuote pero deliberadamente nunca se imprime (es información interna
 * operativa, no parte del documento comercial).
 */
@Injectable()
export class QuoteDocumentRenderer {
  render(quote: SafeQuote): string {
    const documentTypeLine =
      quote.customerDocumentType !== null &&
      quote.customerDocumentNumber !== null
        ? `<p><strong>Documento:</strong> ${escapeHtml(quote.customerDocumentType)} ${escapeHtml(quote.customerDocumentNumber)}</p>`
        : '';
    const addressLine =
      quote.customerAddress !== null
        ? `<p><strong>Dirección:</strong> ${escapeHtml(quote.customerAddress)}</p>`
        : '';
    const notesSection =
      quote.notes !== null
        ? `<h2>Notas</h2><p>${escapeHtml(quote.notes)}</p>`
        : '';

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(quote.number)}</title>
<style>${INLINE_CSS}</style>
</head>
<body>
  <h1>Cotización ${escapeHtml(quote.number)}</h1>
  <p><strong>Estado:</strong> ${escapeHtml(String(quote.status))}</p>
  <p><strong>Fecha de emisión:</strong> ${escapeHtml(quote.issueDate)}</p>
  <p><strong>Fecha de vencimiento:</strong> ${escapeHtml(quote.expirationDate)}</p>

  <h2>Cliente</h2>
  <p><strong>${escapeHtml(quote.customerName)}</strong> (${escapeHtml(String(quote.customerType))})</p>
  ${documentTypeLine}
  ${addressLine}

  <h2>Vendedor</h2>
  <p>${escapeHtml(quote.seller.firstName)} ${escapeHtml(quote.seller.lastName)} (${escapeHtml(quote.seller.username)})</p>

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
      ${quote.items.map((item) => this.renderItemRow(item)).join('\n      ')}
    </tbody>
  </table>

  <div class="totals">
    <p>Subtotal: ${escapeHtml(quote.subtotal)}</p>
    <p>Descuento: ${escapeHtml(quote.discountAmount)}</p>
    <p>Impuesto: ${escapeHtml(quote.taxAmount)}</p>
    <p class="total-final">Total: ${escapeHtml(quote.total)}</p>
  </div>

  ${notesSection}
</body>
</html>`;
  }

  private renderItemRow(item: SafeQuoteItem): string {
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
