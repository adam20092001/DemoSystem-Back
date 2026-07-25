import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ComponentStatus, HealthResponseDto } from './dto/health-response.dto';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthResponseDto> {
    const database = await this.checkDatabase();

    return {
      status: database === 'up' ? 'ok' : 'error',
      application: 'up',
      database,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Comprueba PostgreSQL con una consulta trivial.
   * El detalle del fallo se registra en el servidor y nunca se devuelve al
   * cliente, para no filtrar cadenas de conexión ni mensajes del motor.
   */
  private async checkDatabase(): Promise<ComponentStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch (error: unknown) {
      this.logger.error(
        'PostgreSQL no responde a la comprobación de salud',
        error instanceof Error ? error.stack : String(error),
      );
      return 'down';
    }
  }
}
