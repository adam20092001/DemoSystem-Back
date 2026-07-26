import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { PaginatedUsersResponseDto } from './dto/paginated-users-response.dto';
import { ResetPasswordResponseDto } from './dto/reset-password-response.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { PaginatedResult } from './types/list-users.query';
import { ResetPasswordResult } from './types/reset-password.result';
import { SafeUser } from './types/safe-user';
import { UsersService } from './users.service';

/**
 * Toda la administración de usuarios es exclusiva de ADMIN. El backend nunca
 * confía en permisos del frontend: @Roles() se valida contra el rol leído de
 * PostgreSQL por RolesGuard en cada petición.
 */
@ApiTags('Users')
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
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Lista usuarios de forma paginada' })
  @ApiOkResponse({ type: PaginatedUsersResponseDto })
  list(@Query() query: ListUsersQueryDto): Promise<PaginatedResult<SafeUser>> {
    return this.usersService.listUsers(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un usuario por id' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<SafeUser> {
    return this.usersService.findUserById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Crea un usuario' })
  @ApiCreatedResponse({ type: UserResponseDto })
  @ApiConflictResponse({
    description: 'username o email ya existen',
    type: ErrorResponseDto,
  })
  create(
    @Body() dto: CreateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeUser> {
    return this.usersService.createUser({
      firstName: dto.firstName,
      lastName: dto.lastName,
      username: dto.username,
      email: dto.email,
      temporaryPassword: dto.temporaryPassword,
      roleName: dto.roleName,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edita firstName, lastName, email o roleName',
    description: 'Al menos un campo es obligatorio.',
  })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeUser> {
    return this.usersService.updateUser({
      userId: id,
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      roleName: dto.roleName,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @Post(':id/block')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bloquea un usuario' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description: 'Ya estaba bloqueado, o es el único ADMIN activo',
    type: ErrorResponseDto,
  })
  block(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeUser> {
    return this.usersService.blockUser({
      targetUserId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @Post(':id/unblock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desbloquea un usuario' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description: 'No estaba bloqueado',
    type: ErrorResponseDto,
  })
  unblock(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeUser> {
    return this.usersService.unblockUser({
      targetUserId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Genera una contraseña temporal',
    description:
      'La contraseña temporal se devuelve una única vez en esta respuesta; ' +
      'no se persiste en claro ni se audita.',
  })
  @ApiOkResponse({ type: ResetPasswordResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<ResetPasswordResult> {
    return this.usersService.resetPassword({
      targetUserId: id,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
    });
  }
}
