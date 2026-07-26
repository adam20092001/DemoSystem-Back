import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { HealthResponseDto } from './dto/health-response.dto';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Estado de la aplicación y de la base de datos',
    description:
      'Devuelve 200 cuando PostgreSQL responde y 503 cuando no está disponible. ' +
      'El cuerpo mantiene la misma forma en ambos casos.',
  })
  @ApiOkResponse({
    description: 'Aplicación y base de datos operativas',
    type: HealthResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'La base de datos no está disponible',
    type: HealthResponseDto,
  })
  async check(
    @Res({ passthrough: true }) response: Response,
  ): Promise<HealthResponseDto> {
    const result = await this.healthService.check();

    // El código HTTP depende del estado; el cuerpo no cambia de forma.
    response.status(
      result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    );

    return result;
  }
}
