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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { AccountingService } from './accounting.service';
import { AccountResponseDto } from './dto/account-response.dto';
import { SafeAccount } from './types/safe-account';

const READ_ROLES = [RoleName.ADMIN, RoleName.MANAGEMENT] as const;

@ApiTags('Basic Accounting')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accountingService: AccountingService) {}

  @ApiOperation({
    summary: 'Listar el plan de cuentas básico',
    description:
      'Las seis cuentas del plan de cuentas básico interno son fijas e inmutables en este MVP (sin alta/edición/baja). No es un plan de cuentas PCGE ni un catálogo contable formal.',
  })
  @ApiOkResponse({ type: [AccountResponseDto] })
  @Roles(...READ_ROLES)
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<SafeAccount[]> {
    return this.accountingService.listAccounts(user.role);
  }
}
