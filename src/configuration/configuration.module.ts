import { Module } from '@nestjs/common';
import { ConfigurationController } from './configuration.controller';
import { ConfigurationService } from './configuration.service';
import { SettingsReader } from './settings-reader.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database, Audit)
 * — AuditModule es @Global(), así que este módulo no necesita importarlo
 * explícitamente. SettingsReader se exporta para que QuotesModule/
 * SalesModule lo consuman en los Bloques B/C sin reestructurar este módulo;
 * ConfigurationService (lectura/escritura administrativa completa) no se
 * exporta — solo el puerto de lectura estrecho es de interés fuera de este
 * módulo.
 */
@Module({
  controllers: [ConfigurationController],
  providers: [ConfigurationService, SettingsReader],
  exports: [SettingsReader],
})
export class ConfigurationModule {}
