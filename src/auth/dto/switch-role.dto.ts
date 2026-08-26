import { ApiProperty } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { IsEnum } from 'class-validator';

/**
 * KAN-18, Bloque B: el rol solicitado para ESTA sesión, uno de los 4 valores
 * cerrados de RoleName — nunca un roleId (la asignación persistente vive en
 * UserRole y no se toca aquí; ver AuthService.switchRole()). Un valor fuera
 * del enum, un cuerpo vacío o cualquier propiedad no declarada (p. ej.
 * `roleId`) son rechazados por el ValidationPipe global
 * (whitelist + forbidNonWhitelisted) antes de llegar al controller.
 */
export class SwitchRoleDto {
  @ApiProperty({
    enum: RoleName,
    example: RoleName.SELLER,
    description:
      'Rol a activar para esta sesión. Debe estar ya asignado al usuario.',
  })
  @IsEnum(RoleName)
  role!: RoleName;
}
