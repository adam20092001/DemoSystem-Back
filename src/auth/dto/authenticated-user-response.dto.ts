import { ApiProperty } from '@nestjs/swagger';
import { RoleName, UserStatus } from '@prisma/client';

/**
 * Respuesta de `GET /auth/me` (KAN-18, Bloque A). Refleja exactamente
 * AuthenticatedUser: `role` es el único rol ACTIVO de esta sesión, ya
 * validado en vivo contra PostgreSQL — nunca la colección completa de
 * roles asignados (eso es UserResponseDto.roles, en la administración
 * persistente de usuarios).
 */
export class AuthenticatedUserResponseDto {
  @ApiProperty({ example: 'b3f1c2a0-...-uuid' })
  id!: string;

  @ApiProperty({ example: 'Juan' })
  firstName!: string;

  @ApiProperty({ example: 'Pérez' })
  lastName!: string;

  @ApiProperty({ example: 'jperez' })
  username!: string;

  @ApiProperty({ example: 'jperez@demosystem.local' })
  email!: string;

  @ApiProperty({
    enum: RoleName,
    example: RoleName.SELLER,
    description:
      'Rol activo de esta sesión, validado en vivo en cada petición.',
  })
  role!: RoleName;

  @ApiProperty({ enum: UserStatus, example: UserStatus.ACTIVE })
  status!: UserStatus;

  @ApiProperty({ example: false })
  mustChangePassword!: boolean;

  @ApiProperty({ example: '2026-07-25T00:00:00.000Z', nullable: true })
  lastLoginAt!: Date | null;

  @ApiProperty({ example: '2026-07-25T00:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-07-25T00:00:00.000Z' })
  updatedAt!: Date;
}
