import { Injectable } from '@nestjs/common';
import { ElectronicDocumentStatus, FiscalDocumentType } from '@prisma/client';
import {
  SafeElectronicDocument,
  SafeElectronicDocumentItem,
} from '../types/safe-electronic-document';

const MOCK_PROVIDER_CODE = 'MOCK';
const UNKNOWN_OUTCOME_PROVIDER_STATUS = 'UNKNOWN_OUTCOME';

/**
 * Escapa los 5 caracteres HTML peligrosos, con "&" PRIMERO (si no, las
 * entidades insertadas por los reemplazos siguientes se escaparían de
 * nuevo). Único punto de inserción de texto dinámico en el documento: todo
 * string proveniente de la base de datos pasa por aquí antes de
 * interpolarse. Duplicado deliberadamente respecto a SaleDocumentRenderer
 * (mismo criterio ya establecido en ese archivo, Fase 6): no se extrae un
 * helper compartido entre dominios para no acoplar Ventas y Facturación
 * Electrónica por una deduplicación menor.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DOCUMENT_TYPE_TITLES: Record<FiscalDocumentType, string> = {
  [FiscalDocumentType.FACTURA]: 'FACTURA ELECTRÓNICA — DEMO',
  [FiscalDocumentType.BOLETA]: 'BOLETA ELECTRÓNICA — DEMO',
};

/**
 * Etiquetas de presentación en español (Bloque 11E §19): nunca alteran el
 * enum persistido (ElectronicDocumentStatus), solo cómo se muestra en este
 * HTML. El caso ACCEPTED + proveedor MOCK usa una redacción propia (ver
 * renderStatusLabel) para nunca insinuar una aceptación real de SUNAT.
 */
const STATUS_LABELS: Record<ElectronicDocumentStatus, string> = {
  [ElectronicDocumentStatus.CREATED]: 'Creado',
  [ElectronicDocumentStatus.SUBMITTED]: 'Enviado / pendiente de confirmación',
  [ElectronicDocumentStatus.SUBMISSION_FAILED]: 'Fallo técnico de envío',
  [ElectronicDocumentStatus.ACCEPTED]: 'Aceptado por proveedor',
  [ElectronicDocumentStatus.REJECTED]: 'Rechazado por proveedor',
};

/** Sin recursos remotos (fuentes/CSS/JS), sin <script>, todo inline. */
const INLINE_CSS = `
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 24px; }
  .notice { font-size: 12px; font-weight: bold; letter-spacing: 0.5px; color: #555; border: 1px solid #999; display: inline-block; padding: 4px 8px; margin-bottom: 12px; }
  .demo-warning { font-size: 12px; color: #7a4b00; background: #fff6e0; border: 1px solid #e0b04a; padding: 10px 14px; margin-bottom: 16px; }
  .demo-warning strong { display: block; margin-bottom: 4px; font-size: 13px; }
  .unknown-outcome-warning { font-size: 12px; color: #7a0026; background: #ffe9ee; border: 1px solid #d0002f; padding: 10px 14px; margin-bottom: 16px; }
  .unknown-outcome-warning strong { display: block; margin-bottom: 4px; font-size: 13px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  h2 { font-size: 14px; margin-top: 20px; margin-bottom: 4px; }
  p { margin: 2px 0; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; font-size: 12px; }
  th { background: #f0f0f0; text-align: left; }
  td.amount, th.amount { text-align: right; }
  .totals { margin-top: 12px; text-align: right; }
  .totals p { font-size: 13px; }
  .total-final { font-size: 15px; font-weight: bold; }
  @media print {
    .demo-warning, .unknown-outcome-warning { break-inside: avoid; }
    h1, h2, .totals { break-inside: avoid; }
    tr { break-inside: avoid; }
  }
`;

/**
 * Genera la representación HUMANA imprimible de un documento fiscal ya
 * emitido (GET /electronic-documents/:id/print, Fase 11, Bloque E). Recibe
 * ÚNICAMENTE el contrato SafeElectronicDocument ya seguro (snapshot
 * congelado + ítems): nunca consulta la base ni lee CompanySettings/
 * Customer/Product en vivo, así que la representación histórica nunca
 * cambia aunque esos datos cambien después. NO es una representación
 * fiscal real (sin QR, sin XML/UBL, sin CDR, sin firma digital): un aviso
 * de demostración es obligatorio y siempre visible (§10).
 */
@Injectable()
export class ElectronicDocumentRenderer {
  render(doc: SafeElectronicDocument): string {
    const title = DOCUMENT_TYPE_TITLES[doc.documentType];
    const statusLabel = this.renderStatusLabel(doc);
    const isGenericCustomer =
      doc.customerDocumentType === null && doc.customerDocumentNumber === null;

    const customerDocumentLine =
      !isGenericCustomer &&
      doc.customerDocumentType !== null &&
      doc.customerDocumentNumber !== null
        ? `<p><strong>Documento:</strong> ${escapeHtml(doc.customerDocumentType)} ${escapeHtml(doc.customerDocumentNumber)}</p>`
        : '';
    const customerAddressLine =
      doc.customerAddress !== null
        ? `<p><strong>Dirección:</strong> ${escapeHtml(doc.customerAddress)}</p>`
        : '';
    const issuerAddressLine =
      doc.issuerAddress !== null
        ? `<p><strong>Dirección:</strong> ${escapeHtml(doc.issuerAddress)}</p>`
        : '';
    const providerMessageLine =
      doc.providerMessage !== null && doc.providerMessage.trim().length > 0
        ? `<p><strong>Mensaje del proveedor:</strong> ${escapeHtml(doc.providerMessage)}</p>`
        : '';
    const unknownOutcomeWarning = this.renderUnknownOutcomeWarning(doc);

    const sortedItems = [...doc.items].sort(
      (a, b) => a.lineNumber - b.lineNumber,
    );

    return `<!doctype html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(doc.fullNumber)}</title>
<style>${INLINE_CSS}</style>
</head>
<body>
  <p class="notice">REPRESENTACIÓN IMPRESA DE DEMOSTRACIÓN — NO ES UN COMPROBANTE FISCAL VÁLIDO</p>
  <div class="demo-warning">
    <strong>DOCUMENTO DE DEMOSTRACIÓN</strong>
    Este documento fue generado por el entorno de demostración de Fase 11. No constituye un comprobante fiscal válido ante SUNAT ni ninguna otra entidad tributaria.
    ${
      doc.providerCode === MOCK_PROVIDER_CODE
        ? 'Proveedor electrónico: MOCK. El estado mostrado por el proveedor de demostración no implica aceptación, registro ni validez tributaria ante SUNAT.'
        : `Proveedor electrónico: ${escapeHtml(doc.providerCode)}.`
    }
  </div>
  ${unknownOutcomeWarning}

  <h1>${escapeHtml(title)}</h1>
  <p><strong>Número:</strong> ${escapeHtml(doc.fullNumber)}</p>
  <p><strong>Fecha de emisión:</strong> ${escapeHtml(doc.issuedAt.toISOString())}</p>
  <p><strong>Moneda:</strong> ${escapeHtml(doc.currencyCode)}</p>
  <p><strong>Estado:</strong> ${escapeHtml(statusLabel)}</p>
  <p><strong>Venta relacionada (referencia comercial interna):</strong> ${escapeHtml(doc.saleNumber)}</p>

  <h2>Emisor</h2>
  <p><strong>Razón social:</strong> ${escapeHtml(doc.issuerBusinessName)}</p>
  <p><strong>RUC:</strong> ${escapeHtml(doc.issuerTaxId)}</p>
  ${issuerAddressLine}

  <h2>Cliente</h2>
  ${
    isGenericCustomer
      ? `<p><strong>Público general</strong></p>`
      : `<p><strong>${escapeHtml(doc.customerName)}</strong></p>`
  }
  ${customerDocumentLine}
  ${customerAddressLine}

  <h2>Ítems</h2>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>SKU</th>
        <th>Descripción</th>
        <th>Unidad</th>
        <th class="amount">Cantidad</th>
        <th class="amount">Precio unitario</th>
        <th class="amount">Total</th>
      </tr>
    </thead>
    <tbody>
      ${sortedItems.map((item) => this.renderItemRow(item)).join('\n      ')}
    </tbody>
  </table>

  <div class="totals">
    <p>Subtotal: ${escapeHtml(doc.subtotal)}</p>
    <p>Descuento: ${escapeHtml(doc.discountAmount)}</p>
    <p>Base imponible: ${escapeHtml(doc.taxableBase)}</p>
    <p>IGV: ${escapeHtml(doc.taxAmount)}</p>
    <p class="total-final">Total: ${escapeHtml(doc.total)}</p>
  </div>

  <h2>Proveedor electrónico</h2>
  <p><strong>Proveedor:</strong> ${escapeHtml(doc.providerCode)}</p>
  <p><strong>Estado del proveedor:</strong> ${escapeHtml(doc.providerStatus ?? '—')}</p>
  ${providerMessageLine}
</body>
</html>`;
  }

  /**
   * §19: nunca altera el enum persistido. ACCEPTED bajo el proveedor MOCK
   * usa una redacción propia para no insinuar jamás una aceptación real de
   * SUNAT (única excepción a la tabla genérica STATUS_LABELS).
   */
  private renderStatusLabel(doc: SafeElectronicDocument): string {
    if (
      doc.status === ElectronicDocumentStatus.ACCEPTED &&
      doc.providerCode === MOCK_PROVIDER_CODE
    ) {
      return 'ACEPTADO POR PROVEEDOR DE DEMOSTRACIÓN';
    }
    return STATUS_LABELS[doc.status];
  }

  /**
   * §20: SUBMITTED + providerStatus=UNKNOWN_OUTCOME significa que el
   * resultado remoto no se conoce con certeza (Bloque 11C, política "fail
   * closed"). Nunca debe insinuarse un rechazo ni una aceptación.
   */
  private renderUnknownOutcomeWarning(doc: SafeElectronicDocument): string {
    if (
      doc.status !== ElectronicDocumentStatus.SUBMITTED ||
      doc.providerStatus !== UNKNOWN_OUTCOME_PROVIDER_STATUS
    ) {
      return '';
    }
    return `<div class="unknown-outcome-warning">
    <strong>Resultado remoto no confirmado.</strong>
    No se pudo confirmar si el proveedor electrónico recibió o procesó este documento. El documento no debe reenviarse automáticamente.
  </div>`;
  }

  private renderItemRow(item: SafeElectronicDocumentItem): string {
    return `<tr>
        <td>${escapeHtml(String(item.lineNumber))}</td>
        <td>${escapeHtml(item.productSku)}</td>
        <td>${escapeHtml(item.description)}</td>
        <td>${escapeHtml(item.unitAbbreviation)} (${escapeHtml(item.unitName)})</td>
        <td class="amount">${escapeHtml(item.quantity)}</td>
        <td class="amount">${escapeHtml(item.unitPrice)}</td>
        <td class="amount">${escapeHtml(item.lineTotal)}</td>
      </tr>`;
  }
}
