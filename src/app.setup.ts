import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { createValidationPipe } from './common/pipes/validation.pipe';
import { AppConfigService } from './config/configuration';

/**
 * Configuración global de la aplicación.
 *
 * Vive aparte de `main.ts` para que las pruebas e2e levanten exactamente la
 * misma configuración que producción (prefijo, versionado, CORS, validación
 * y formato de errores).
 */
export function setupApp(app: INestApplication): void {
  const config = app.get<AppConfigService>(ConfigService);

  // Sin firmar: el contenido ya viaja firmado criptográficamente como JWT.
  app.use(cookieParser());

  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  app.enableCors({
    origin: config
      .get('CORS_ORIGIN', { infer: true })
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    credentials: true,
  });

  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());

  // Permite que OnModuleDestroy se ejecute ante SIGINT/SIGTERM.
  app.enableShutdownHooks();
}
