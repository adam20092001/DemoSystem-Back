import { AccountsPayableStatus } from '../supplier-payment-calculator';

/**
 * Filtros comunes a los reportes de cuentas por pagar (Fase A5.4):
 * listado general, resumen por proveedor y antigüedad de deuda. Sin
 * `agingBucket` aquí (exclusivo del listado general — ver
 * ListAccountsPayableQuery): filtrar la antigüedad antes de calcularla no
 * tiene sentido en el reporte que justamente la calcula.
 */
export interface AccountsPayableFilterQuery {
  supplierId?: string;
  issueDateFrom?: string;
  issueDateTo?: string;
  status?: AccountsPayableStatus;
}
