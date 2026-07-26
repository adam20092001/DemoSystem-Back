import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Global para que UsersModule (y AuthModule en el Bloque C) puedan inyectar
 * AuditService sin reimportar el módulo. Sin controller en esta fase: la
 * consulta de auditoría se implementará más adelante.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
