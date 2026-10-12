import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { MAX_INITIAL_PAYMENTS } from '../../payments/constants/payment.constants';
import { InitialPaymentDto } from '../../payments/dto/initial-payment.dto';

/**
 * Cuerpo de POST /sales/from-quote/:quoteId (Fase 7, Bloque C). Sin cuerpo
 * comercial: precio/descuento/ítems/cliente/vendedor siguen siendo copia
 * exacta e inmutable de la cotización (D9 de la Fase 6), nunca aceptados
 * aquí. `payment` y `payments` (R1) son los ÚNICOS campos, opcionales y
 * mutuamente excluyentes (lo valida el dominio), mismo contrato que el pago
 * inicial de una venta directa. El endpoint debe aceptar sin cuerpo, `{}`,
 * `{ payment: {...} }` y `{ payments: [...] }` por igual.
 */
export class ConvertQuoteToSaleDto {
  @ApiPropertyOptional({
    type: InitialPaymentDto,
    description:
      'Pago inicial opcional registrado en la MISMA transacción que confirma la venta desde la cotización. Excluyente con `payments`.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => InitialPaymentDto)
  payment?: InitialPaymentDto;

  @ApiPropertyOptional({
    type: [InitialPaymentDto],
    minItems: 1,
    maxItems: MAX_INITIAL_PAYMENTS,
    description:
      'R1: lote de 1 a 10 pagos iniciales (métodos repetidos admitidos), registrados en la MISMA transacción que confirma la venta y en el orden recibido; si cualquiera falla, no se confirma nada. Excluyente con `payment` (enviar ambos responde 400). La suma no puede superar el total de la cotización (409).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INITIAL_PAYMENTS)
  @ValidateNested({ each: true })
  @Type(() => InitialPaymentDto)
  payments?: InitialPaymentDto[];
}
