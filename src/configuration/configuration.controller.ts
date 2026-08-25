import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { COOKIE_AUTH_NAME } from '../config/swagger';
import { ConfigurationService } from './configuration.service';
import { ConfigurationResponseDto } from './dto/configuration-response.dto';
import { UpdateConfigurationDto } from './dto/update-configuration.dto';
import { SafeCompanySettings } from './types/safe-company-settings';

const READ_ROLES = [RoleName.ADMIN, RoleName.MANAGEMENT] as const;

@ApiTags('Configuration')
@ApiCookieAuth(COOKIE_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Sin cookie de sesión válida.' })
@ApiForbiddenResponse({ description: 'Rol sin permiso para este endpoint.' })
@Controller('configuration')
export class ConfigurationController {
  constructor(private readonly configurationService: ConfigurationService) {}

  @ApiOperation({ summary: 'Obtener la configuración de la empresa' })
  @ApiOkResponse({ type: ConfigurationResponseDto })
  @Roles(...READ_ROLES)
  @Get()
  get(@CurrentUser() actor: AuthenticatedUser): Promise<SafeCompanySettings> {
    return this.configurationService.getConfiguration(actor.role);
  }

  @ApiOperation({
    summary:
      'Actualizar la configuración de la empresa (identidad, moneda, vigencia de cotización, descuento máximo e IGV)',
    description:
      'Con este bloque los 10 campos de CompanySettings quedan editables: ningún campo permanece bloqueado. taxEnabled/taxRate controlan el IGV interno del sistema (nunca facturación electrónica/SUNAT/PLE); si taxEnabled resultante es true, taxRate resultante debe ser > 0.',
  })
  @ApiOkResponse({ type: ConfigurationResponseDto })
  @ApiBadRequestResponse({
    description:
      'Payload vacío, campo en blanco/inválido, o el par (taxEnabled, taxRate) resultante viola la invariante (taxEnabled=true exige taxRate > 0).',
  })
  @Roles(RoleName.ADMIN)
  @Patch()
  update(
    @Body() dto: UpdateConfigurationDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SafeCompanySettings> {
    return this.configurationService.updateConfiguration({
      businessName: dto.businessName,
      tradeName: dto.tradeName,
      taxId: dto.taxId,
      address: dto.address,
      phone: dto.phone,
      email: dto.email,
      currencyCode: dto.currencyCode,
      currencySymbol: dto.currencySymbol,
      quoteValidityDays: dto.quoteValidityDays,
      maxDiscountPercent: dto.maxDiscountPercent,
      taxEnabled: dto.taxEnabled,
      taxRate: dto.taxRate,
      actorUserId: actor.id,
      ipAddress: request.ip ?? null,
      requesterRole: actor.role,
    });
  }
}
