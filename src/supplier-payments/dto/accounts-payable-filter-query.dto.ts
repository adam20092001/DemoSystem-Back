import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { ACCOUNTS_PAYABLE_STATUS_VALUES } from '../supplier-payment-calculator';
import { IsDateOnly } from './is-date-only.decorator';

/**
 * Filtros comunes a los reportes de cuentas por pagar (Fase A5.4):
 * listado general, resumen por proveedor, antigüedad de deuda y
 * conciliación. `status` filtra sobre el valor DERIVADO (nunca una
 * columna indexable, calculado en el servicio).
 */
export class AccountsPayableFilterQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-01-01',
    description:
      'Fecha de emisión, límite inferior inclusivo. El servicio valida issueDateFrom <= issueDateTo.',
  })
  @IsOptional()
  @IsDateOnly()
  issueDateFrom?: string;

  @ApiPropertyOptional({ type: String, example: '2026-03-31' })
  @IsOptional()
  @IsDateOnly()
  issueDateTo?: string;

  @ApiPropertyOptional({ enum: ACCOUNTS_PAYABLE_STATUS_VALUES })
  @IsOptional()
  @IsIn(ACCOUNTS_PAYABLE_STATUS_VALUES)
  status?: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
}
