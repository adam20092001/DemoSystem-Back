import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethodAccountingDestination } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PAYMENT_METHOD_CODE_PATTERN } from '../constants/payment-method.constants';

/**
 * trim + mayúsculas ANTES de validar (política aprobada: "trim -> uppercase
 * -> regex", en ese orden). Sin este @Transform, un `code` legítimo enviado
 * en minúsculas ("yape") sería rechazado por @Matches (que exige mayúsculas)
 * antes de llegar a normalizarse en el servicio — el DTO debe normalizar
 * primero, exactamente como PaymentMethodsService.createPaymentMethod()
 * normaliza de nuevo como segunda línea de defensa (nunca confía en que la
 * capa HTTP ya lo hizo). Mismo patrón que trimEmail() en
 * customers/dto/create-customer.dto.ts: transform local de un solo uso, sin
 * un helper compartido para un único campo.
 */
function normalizeCode({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

/**
 * `active`/`id`/`createdAt`/`updatedAt` nunca se aceptan aquí: todo método
 * nace `active: true` (Ticket C §7 del kickoff aprobado; sin flujo para
 * crear un método ya inactivo). `code` se normaliza (trim + mayúsculas) e
 * inmutabiliza en el servicio — este DTO es la ÚNICA vía de entrada donde
 * `code` existe como campo de escritura: UpdatePaymentMethodDto
 * deliberadamente no lo declara.
 */
export class CreatePaymentMethodDto {
  @ApiProperty({
    minLength: 2,
    maxLength: 30,
    example: 'YAPE',
    description:
      'Identidad estable e inmutable. Se normaliza a mayúsculas; formato ^[A-Z][A-Z0-9_]{1,29}$ (letra inicial, luego letras/dígitos/guion bajo).',
  })
  @Transform(normalizeCode)
  @IsString()
  @MinLength(2)
  @MaxLength(30)
  @Matches(PAYMENT_METHOD_CODE_PATTERN, {
    message:
      'code debe tener 2-30 caracteres, iniciar con una letra A-Z y contener solo A-Z, 0-9 o guion bajo tras normalizarse a mayúsculas',
  })
  code!: string;

  @ApiProperty({ maxLength: 60, example: 'Yape' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiProperty({
    description:
      'Si es true, un cobro con este método exige una referencia no vacía (número de operación/voucher).',
  })
  @IsBoolean()
  requiresReference!: boolean;

  @ApiProperty({
    description:
      'Si es true, el monto cobrado con este método cuenta como efectivo físico en el futuro arqueo de caja (Ticket B).',
  })
  @IsBoolean()
  affectsCashDrawer!: boolean;

  @ApiProperty({
    enum: PaymentMethodAccountingDestination,
    description:
      'Cuenta contable de cobro (Fase 8, sin cuentas nuevas): CASH -> Caja, BANK -> Bancos. Concepto independiente de affectsCashDrawer/requiresReference.',
  })
  @IsEnum(PaymentMethodAccountingDestination)
  accountingDestination!: PaymentMethodAccountingDestination;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number;
}
