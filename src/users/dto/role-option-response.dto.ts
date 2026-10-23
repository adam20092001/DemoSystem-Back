import { ApiProperty } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

/**
 * Forma pública de GET /roles, únicamente para documentación Swagger.
 * `name` es el identificador estable (el propio valor de `RoleName`) que
 * un selector de Angular debe enviar tal cual en `roleNames`
 * (`POST /users`, `PATCH /users/:id`) — nunca una etiqueta inventada: no
 * existe hoy ninguna fuente de nombres descriptivos para los roles.
 */
export class RoleOptionResponseDto {
  @ApiProperty({ enum: RoleName, example: RoleName.ADMIN })
  name!: RoleName;
}
