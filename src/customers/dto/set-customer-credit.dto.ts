import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Cuerpo de PATCH /customers/:id/credit (NR-02A, exclusivo de ADMIN).
 * Único campo aceptado: deliberadamente separado de UpdateCustomerDto
 * (compartido con SELLER) para que un SELLER nunca pueda alcanzar este
 * campo por ninguna ruta.
 */
export class SetCustomerCreditDto {
  @ApiProperty({
    description:
      'true habilita que este cliente genere ventas con saldo pendiente; false lo impide (no afecta deudas ya existentes, que siguen siendo cobrables).',
  })
  @IsBoolean()
  creditEnabled!: boolean;
}
