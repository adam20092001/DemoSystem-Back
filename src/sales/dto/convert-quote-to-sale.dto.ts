import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { InitialPaymentDto } from '../../payments/dto/initial-payment.dto';

/**
 * Cuerpo de POST /sales/from-quote/:quoteId (Fase 7, Bloque C). Sin cuerpo
 * comercial: precio/descuento/ítems/cliente/vendedor siguen siendo copia
 * exacta e inmutable de la cotización (D9 de la Fase 6), nunca aceptados
 * aquí. `payment` es el ÚNICO campo, opcional, mismo contrato que el pago
 * inicial de una venta directa. El endpoint debe aceptar sin cuerpo, `{}` y
 * `{ payment: {...} }` por igual.
 */
export class ConvertQuoteToSaleDto {
  @ApiPropertyOptional({
    type: InitialPaymentDto,
    description:
      'Pago inicial opcional registrado en la MISMA transacción que confirma la venta desde la cotización.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => InitialPaymentDto)
  payment?: InitialPaymentDto;
}
