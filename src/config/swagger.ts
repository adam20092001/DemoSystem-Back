import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppConfigService } from './configuration';

/** Ruta pública de la documentación interactiva. */
export const SWAGGER_PATH = 'api/docs';

/** Nombre del esquema de seguridad reutilizable en los módulos futuros. */
export const COOKIE_AUTH_NAME = 'cookieAuth';

/**
 * Publica la documentación OpenAPI si SWAGGER_ENABLED es verdadero.
 *
 * El valor llega ya normalizado a booleano desde la validación de entorno,
 * de modo que la cadena "false" se interpreta como false (no se usa Boolean()).
 */
export function setupSwagger(app: INestApplication): boolean {
  const config = app.get<AppConfigService>(ConfigService);

  if (!config.get('SWAGGER_ENABLED', { infer: true })) {
    return false;
  }

  const documentConfig = new DocumentBuilder()
    .setTitle('DemoSystem — Punto de Venta y Gestión Comercial')
    .setDescription(
      'API REST del backend interno de Punto de Venta y Gestión Comercial. ' +
        'Todas las rutas cuelgan del prefijo /api y están versionadas (/api/v1).',
    )
    .setVersion('1.0')
    .addCookieAuth(
      'access_token',
      {
        type: 'apiKey',
        in: 'cookie',
        name: 'access_token',
        description:
          'Sesión mediante cookie HttpOnly. Se emitirá en el módulo de ' +
          'autenticación; todavía no hay endpoints protegidos.',
      },
      COOKIE_AUTH_NAME,
    )
    .addTag('Health', 'Estado de la aplicación y de la base de datos')
    .build();

  const document = SwaggerModule.createDocument(app, documentConfig);
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    swaggerOptions: { withCredentials: true },
  });

  return true;
}
