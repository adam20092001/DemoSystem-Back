import { ApiProperty } from '@nestjs/swagger';
import { RoleName, UserStatus } from '@prisma/client';

/**
 * Forma pública de un usuario, únicamente para documentación Swagger.
 * Refleja SafeUser: nunca passwordHash, failedLoginAttempts ni roleId.
 */
export class UserResponseDto {
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

  @ApiProperty({ enum: RoleName, example: RoleName.SELLER })
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
