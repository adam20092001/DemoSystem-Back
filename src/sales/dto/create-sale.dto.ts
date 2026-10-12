import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { MAX_INITIAL_PAYMENTS } from '../../payments/constants/payment.constants';
import { InitialPaymentDto } from '../../payments/dto/initial-payment.dto';
import { CreateSaleItemDto } from './create-sale-item.dto';

/**
 * Mismo criterio textual que el dominio (sale-calculator.ts, Bloque B):
 * sin notación científica, máximo 2 decimales (Decimal(14,2)). ">=0" y la
 * comparación contra el subtotal las revalida SalesService.
 */
export const SALE_DISCOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Venta directa: POST /sales ES la confirmación (sin DRAFT). number/status/
 * paymentStatus/deliveryStatus/sellerId/confirmedAt/subtotal/taxAmount/
 * total/paidAmount/balanceDue/snapshots de cliente y producto/unitPrice/
 * notas nunca se aceptan aquí: son valores de sistema calculados por
 * SalesService (Bloque B), nunca controlados por el llamador. sellerId se
 * deriva exclusivamente del actor autenticado. `payment` (Fase 7, Bloque C)
 * y `payments` (R1) son los ÚNICOS datos de pago aceptados, opcionales y
 * mutuamente excluyentes (lo valida el dominio, parseInitialPayments), con
 * el mismo contrato por elemento que un pago posterior
 * (InitialPaymentDto == CreatePaymentDto). Sin ninguno, el comportamiento
 * es idéntico a la Fase 6.
 */
export class CreateSaleDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  customerId!: string;

  @ApiPropertyOptional({
    type: String,
    description:
      'Decimal no negativo, como texto, máximo 2 decimales. Ausente equivale a "0".',
    example: '10.00',
  })
  @IsOptional()
  @IsString()
  @Matches(SALE_DISCOUNT_PATTERN, {
    message:
      'discountAmount debe ser un decimal no negativo, como texto, con máximo 2 decimales',
  })
  discountAmount?: string;

  @ApiProperty({ type: [CreateSaleItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateSaleItemDto)
  items!: CreateSaleItemDto[];

  @ApiPropertyOptional({
    type: InitialPaymentDto,
    description:
      'Pago inicial opcional registrado en la MISMA transacción que confirma la venta. Ausente: la venta queda UNPAID por el total (o PAID si el total es 0), igual que en la Fase 6. Una venta a Público general o a un cliente bloqueado con total positivo solo se confirma si este pago salda el saldo por completo.',
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
      'R1: lote de 1 a 10 pagos iniciales (métodos repetidos admitidos), registrados en la MISMA transacción que confirma la venta y en el orden recibido; si cualquiera falla, no se confirma nada. Excluyente con `payment` (enviar ambos responde 400). La suma no puede superar el total (409); Público general o cliente bloqueado exigen que la suma salde el total.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INITIAL_PAYMENTS)
  @ValidateNested({ each: true })
  @Type(() => InitialPaymentDto)
  payments?: InitialPaymentDto[];
}
