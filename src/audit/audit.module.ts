import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditQueryService } from './audit-query.service';
import { AuditService } from './audit.service';

/**
 * Global para que todos los módulos de dominio (Users, Auth, Categories,
 * Units, Products, Inventory, Customers, Quotes, Sales, Payments,
 * Accounting, Configuration) puedan inyectar AuditService sin reimportar
 * este módulo. AuditService (infraestructura de escritura, transaccional)
 * sigue siendo la única exportación: AuditQueryService (Fase 10, Bloque E,
 * lectura HTTP de solo consulta) es de uso exclusivo de AuditController,
 * deliberadamente NO exportado — ningún módulo de dominio debe consumir la
 * capa de lectura de auditoría, y AuditQueryService nunca inyecta
 * AuditService (ninguna lectura de este módulo genera una fila de
 * auditoría).
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditQueryService],
  exports: [AuditService],
})
export class AuditModule {}
