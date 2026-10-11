import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';

/**
 * Forma pública de GET /users/lookup, únicamente para documentación Swagger.
 * Refleja UserLookupItem: identidad mínima, nunca email, roles ni campos de
 * seguridad (ver UserResponseDto para la forma administrativa completa,
 * exclusiva de ADMIN).
 */
export class UserLookupResponseDto {
  @ApiProperty({ example: 'b3f1c2a0-...-uuid' })
  id!: string;

  @ApiProperty({ example: 'jperez' })
  username!: string;

  @ApiProperty({ example: 'Juan' })
  firstName!: string;

  @ApiProperty({ example: 'Pérez' })
  lastName!: string;

  @ApiProperty({
    enum: UserStatus,
    example: UserStatus.ACTIVE,
    description:
      'Incluye INACTIVE/BLOCKED: un usuario histórico puede tener Ventas o Cobros registrados.',
  })
  status!: UserStatus;
}
