import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { toStrictBoolean } from '../../common/validators/to-strict-boolean.transform';

export class ListPaymentMethodsQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Solo ADMIN puede solicitarlo. Acepta true/false (boolean o string); cualquier otro valor falla la validación. Omitido o false: solo métodos activos. true (ADMIN): todos, incluidos los legacy inactivos.',
  })
  @IsOptional()
  @Transform(toStrictBoolean)
  @IsBoolean()
  includeInactive?: boolean;
}
