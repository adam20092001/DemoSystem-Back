import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Acceso a datos. Es global para que los módulos del MVP puedan inyectar
 * PrismaService sin repetir el import en cada uno.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
