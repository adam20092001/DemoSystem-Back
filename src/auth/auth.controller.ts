import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AllowPendingPassword } from '../common/decorators/allow-pending-password.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { TokenService } from './token.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
  ) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Inicia sesión con username o email',
    description:
      'El JWT se entrega exclusivamente en una cookie HttpOnly; nunca en el ' +
      'cuerpo de la respuesta.',
  })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Credenciales inválidas',
    type: ErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'Demasiados intentos de login',
    type: ErrorResponseDto,
  })
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UserResponseDto> {
    const { user, token } = await this.authService.login({
      identifier: dto.identifier,
      password: dto.password,
      ipAddress: request.ip ?? null,
    });

    this.tokenService.setAuthCookie(response, token);

    return user;
  }

  @AllowPendingPassword()
  @ApiCookieAuth(COOKIE_AUTH_NAME)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cierra la sesión eliminando la cookie' })
  @ApiResponse({ status: 204 })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  logout(@Res({ passthrough: true }) response: Response): void {
    this.tokenService.clearAuthCookie(response);
  }

  @AllowPendingPassword()
  @ApiCookieAuth(COOKIE_AUTH_NAME)
  @Get('me')
  @ApiOperation({ summary: 'Usuario autenticado, leído en vivo de PostgreSQL' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  @AllowPendingPassword()
  @ApiCookieAuth(COOKIE_AUTH_NAME)
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cambia la contraseña propia',
    description:
      'Permitido incluso cuando mustChangePassword es true, para completar ' +
      'el cambio obligatorio inicial.',
  })
  @ApiResponse({ status: 204 })
  @ApiUnauthorizedResponse({
    description: 'Contraseña actual incorrecta',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'La contraseña no cumple la política o es igual a la actual',
    type: ErrorResponseDto,
  })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.authService.changePassword({
      userId: user.id,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
      ipAddress: request.ip ?? null,
    });
  }
}
