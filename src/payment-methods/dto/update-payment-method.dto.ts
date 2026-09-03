import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethodAccountingDestination } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * `code` deliberadamente AUSENTE (Ticket C §14 del audit: inmutable después
 * de creado). El ValidationPipe global usa `whitelist: true` +
 * `forbidNonWhitelisted: true` (CLAUDE.md §3): un `code` enviado en el body
 * de un PATCH nunca llega al controller ni al servicio — la petición
 * completa se rechaza con 400 antes de eso — no existe ninguna ruta de
 * código capaz de escribirlo después de la creación.
 */
export class UpdatePaymentMethodDto {
  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Activa/desactiva el método para nuevos cobros (nunca borra el histórico).',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresReference?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  affectsCashDrawer?: boolean;

  @ApiPropertyOptional({ enum: PaymentMethodAccountingDestination })
  @IsOptional()
  @IsEnum(PaymentMethodAccountingDestination)
  accountingDestination?: PaymentMethodAccountingDestination;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number;
}
