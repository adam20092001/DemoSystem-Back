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

  const cookieName = config.get('AUTH_COOKIE_NAME', { infer: true });

  const documentConfig = new DocumentBuilder()
    .setTitle('DemoSystem — Punto de Venta y Gestión Comercial')
    .setDescription(
      'API REST del backend interno de Punto de Venta y Gestión Comercial. ' +
        'Todas las rutas cuelgan del prefijo /api y están versionadas (/api/v1).',
    )
    .setVersion('1.0')
    .addCookieAuth(
      cookieName,
      {
        type: 'apiKey',
        in: 'cookie',
        name: cookieName,
        description:
          'Sesión mediante JWT en cookie HttpOnly, emitida por POST /auth/login.',
      },
      COOKIE_AUTH_NAME,
    )
    .addTag('Health', 'Estado de la aplicación y de la base de datos')
    .addTag('Auth', 'Autenticación, sesión y cambio de contraseña')
    .addTag('Users', 'Administración de usuarios (solo ADMIN)')
    .addTag('Categories', 'Categorías de productos (jerárquicas)')
    .addTag('Units', 'Unidades de medida')
    .addTag('Products', 'Productos y servicios del catálogo')
    .addTag(
      'Product Specifications',
      'Especificaciones técnicas de un producto',
    )
    .addTag('Product Images', 'Imágenes de un producto')
    .addTag(
      'Inventory',
      'Movimientos de stock, kardex, stock actual y stock bajo',
    )
    .addTag(
      'Customers',
      'Clientes y prospectos, incluido el cliente genérico "Público general"',
    )
    .addTag(
      'Quotes',
      'Cotizaciones: propuestas comerciales que no reservan ni descuentan stock. ' +
        'La conversión a venta pertenece a una fase posterior.',
    )
    .build();

  const document = SwaggerModule.createDocument(app, documentConfig);
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    swaggerOptions: { withCredentials: true },
  });

  return true;
}
