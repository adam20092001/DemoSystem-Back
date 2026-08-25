import { Module } from '@nestjs/common';
import { ConfigurationController } from './configuration.controller';
import { ConfigurationService } from './configuration.service';
import { SequenceAdminController } from './sequence-admin.controller';
import { SequenceAdminService } from './sequence-admin.service';
import { SettingsReader } from './settings-reader.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database, Audit)
 * — AuditModule es @Global(), así que este módulo no necesita importarlo
 * explícitamente. SettingsReader se exporta para que QuotesModule/
 * SalesModule lo consuman en los Bloques B/C sin reestructurar este módulo;
 * ConfigurationService (lectura/escritura administrativa completa) no se
 * exporta — solo el puerto de lectura estrecho es de interés fuera de este
 * módulo. SequenceAdminService (Fase 10, Bloque D: administración de
 * prefix/padding/currentNumber) tampoco se exporta: es exclusivamente HTTP,
 * deliberadamente independiente de DocumentSequenceService.next() (Fase 5,
 * Bloque B), que sigue viviendo en DocumentSequencesModule y siendo
 * consumido directamente por QuotesModule/SalesModule para la generación
 * automática de correlativos.
 */
@Module({
  controllers: [ConfigurationController, SequenceAdminController],
  providers: [ConfigurationService, SequenceAdminService, SettingsReader],
  exports: [SettingsReader],
})
export class ConfigurationModule {}
