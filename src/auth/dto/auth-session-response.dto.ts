import { ApiProperty } from '@nestjs/swagger';
import { RoleName, UserStatus } from '@prisma/client';

/**
 * Respuesta de `POST /auth/login` (KAN-18, Bloque A). Deliberadamente
 * distinta de UserResponseDto (administración persistente de usuarios):
 * `roles` son TODOS los roles asignados; `activeRole` es el único rol con
 * el que esta sesión concreta autenticó — el mismo valor validado dentro
 * del JWT (nunca expuesto en el cuerpo de la respuesta, solo en la cookie
 * HttpOnly).
 */
export class AuthSessionResponseDto {
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
    isArray: true,
    example: [RoleName.ADMIN, RoleName.SELLER],
    description: 'Todos los roles asignados al usuario.',
  })
  roles!: RoleName[];

  @ApiProperty({
    enum: RoleName,
    example: RoleName.SELLER,
    description:
      'Rol con el que esta sesión quedó autenticada. Con un solo rol asignado, coincide con roles[0].',
  })
  activeRole!: RoleName;

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
