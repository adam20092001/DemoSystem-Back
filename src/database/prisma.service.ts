import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Cliente Prisma gestionado por el ciclo de vida de NestJS.
 *
 * La conexión se abre en onModuleInit y se cierra en onModuleDestroy.
 * No se usa el patrón obsoleto `$on('beforeExit')`; el cierre ordenado del
 * proceso se completará con `app.enableShutdownHooks()` en el Bloque B.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Conexión a PostgreSQL establecida');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Conexión a PostgreSQL cerrada');
  }
}
