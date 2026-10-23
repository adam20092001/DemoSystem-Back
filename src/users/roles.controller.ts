import { Controller, Get } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { RoleOptionResponseDto } from './dto/role-option-response.dto';
import { RoleOption } from './types/role-option';
import { UsersService } from './users.service';

/**
 * Catálogo de roles del sistema para el selector de Angular (hoy
 * hardcodeado en el frontend). Los roles son el enum de Prisma `RoleName`,
 * no registros dinámicos en una tabla — ver `UsersService.listRoles()`.
 * Exclusivo de ADMIN, mismo criterio que el resto de la administración de
 * usuarios/roles (`UsersController`): esto NO crea, edita ni elimina
 * ningún rol.
 */
@ApiTags('Roles')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({
  description: 'No autenticado',
  type: ErrorResponseDto,
})
@ApiForbiddenResponse({
  description: 'Autenticado pero sin rol ADMIN',
  type: ErrorResponseDto,
})
@Roles(RoleName.ADMIN)
@Controller('roles')
export class RolesController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista los roles del sistema',
    description:
      'Deriva siempre de Object.values(RoleName) — nunca un arreglo duplicado a mano. `name` es el identificador estable a enviar en roleNames (POST/PATCH /users).',
  })
  @ApiOkResponse({ type: [RoleOptionResponseDto] })
  list(): RoleOption[] {
    return this.usersService.listRoles();
  }
}
