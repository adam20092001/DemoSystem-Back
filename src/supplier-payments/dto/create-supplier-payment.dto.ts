import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  MAX_SUPPLIER_PAYMENT_ALLOCATIONS,
  SUPPLIER_PAYMENT_REFERENCE_MAX_LENGTH,
} from '../constants/supplier-payment.constants';
import { CreateSupplierPaymentAllocationDto } from './create-supplier-payment-allocation.dto';
import { IsDateOnly } from './is-date-only.decorator';

/**
 * id/status/currencyCode/paymentMethodId/Code/Name/postedEntryId/
 * createdByUserId/cancelación nunca se aceptan: son valores de sistema
 * fijados por SupplierPaymentsService. `method` solo valida forma HTTP
 * mínima (mismo criterio que CreatePaymentDto): existencia, actividad y
 * requiresReference son responsabilidad exclusiva del dominio. La suma de
 * `allocations[].amount` debe ser exactamente igual a `amount` (validado en
 * el servicio, nunca aquí). Todas las facturas referenciadas deben
 * pertenecer a `supplierId` y estar CONFIRMED (validado en el servicio).
 */
export class CreateSupplierPaymentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  supplierId!: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-10-21',
    description: 'Por defecto, la fecha de negocio actual si se omite.',
  })
  @IsOptional()
  @IsDateOnly()
  paymentDate?: string;

  @ApiProperty({
    type: String,
    description:
      'Decimal positivo, como texto, máximo 2 decimales. Debe ser exactamente igual a la suma de allocations[].amount.',
    example: '300.00',
  })
  @IsString()
  @Matches(/^\d{1,12}(\.\d{1,2})?$/, {
    message:
      'amount debe ser un decimal positivo, como texto, con máximo 2 decimales',
  })
  amount!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 30,
    example: 'CASH',
    description:
      'Código de un método de pago dinámico (ver GET /payment-methods). Se normaliza a mayúsculas en el dominio; debe existir y estar activo, o la petición se rechaza (404/409).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  method!: string;

  @ApiPropertyOptional({
    maxLength: SUPPLIER_PAYMENT_REFERENCE_MAX_LENGTH,
    description:
      'Obligatoria cuando el método de pago resuelto tiene requiresReference=true; opcional en caso contrario.',
    example: 'OP-000456',
  })
  @IsOptional()
  @IsString()
  @MaxLength(SUPPLIER_PAYMENT_REFERENCE_MAX_LENGTH)
  reference?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Clave de idempotencia opcional, única por proveedor. Reenviarla tal cual en un reintento HTTP devuelve el MISMO pago ya creado, sin duplicar ningún efecto.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;

  @ApiProperty({
    type: [CreateSupplierPaymentAllocationDto],
    maxItems: MAX_SUPPLIER_PAYMENT_ALLOCATIONS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SUPPLIER_PAYMENT_ALLOCATIONS)
  @ValidateNested({ each: true })
  @Type(() => CreateSupplierPaymentAllocationDto)
  allocations!: CreateSupplierPaymentAllocationDto[];
}
