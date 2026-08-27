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
    .addTag(
      'Sales',
      'Ventas directas o desde cotización: confirmación inmediata (sin borrador), ' +
        'descuento real de stock, anulación con reversa histórica y nota de venta ' +
        'interna no fiscal. Admiten un pago inicial opcional al confirmar. Los ' +
        'campos de resumen de pago (paymentStatus/paidAmount/balanceDue) se ' +
        'recalculan desde los pagos ACTIVE de la venta (módulo Pagos); para una ' +
        'venta ANULADA quedan congelados con su valor histórico previo a la ' +
        'anulación.',
    )
    .addTag(
      'Payments',
      'Cobros aplicados a una venta (Documento Maestro §16): pago completo o ' +
        'parcial al confirmar la venta o en un momento posterior, y anulación ' +
        'manual con motivo obligatorio. Un pago nunca se edita ni se elimina ' +
        'físicamente. No existe un endpoint de detalle de pago independiente: el ' +
        'historial completo de una venta se consulta en su detalle ' +
        '(GET /sales/:id).',
    )
    .addTag(
      'Accounts Receivable',
      'Consulta de solo lectura de ventas ACTIVE con saldo pendiente positivo, ' +
        'deuda más antigua primero. No es un libro contable formal ni sustituye ' +
        'la contabilidad básica de una fase posterior.',
    )
    .addTag(
      'Basic Accounting',
      'Consulta de solo lectura del plan de cuentas básico y de los asientos ' +
        'contables generados automáticamente al confirmar una venta y al ' +
        'registrar/anular un pago (partida doble, DEBE = HABER). Es una ' +
        'pre-contabilidad interna automática pensada como insumo de apoyo; ' +
        'NO reemplaza un software contable formal, y NO es contabilidad ' +
        'SUNAT/PLE ni ningún tipo de libro contable fiscal.',
    )
    .addTag(
      'Reports',
      'Reportes operativos de solo lectura sobre ventas, cobranza y ' +
        'cotizaciones (ventas por producto/cliente/vendedor, cotizaciones ' +
        'por estado, pagos por método). Son vistas agregadas/tabulares ' +
        'calculadas al momento de la solicitud sobre datos ya existentes; ' +
        'NO son contabilidad formal, NO son reportes fiscales SUNAT/PLE, y ' +
        'NO constituyen una plataforma de Business Intelligence.',
    )
    .addTag(
      'Dashboard',
      'Panel compuesto de solo lectura (una única respuesta con hasta 5 ' +
        'secciones: sales, collections, lowStock, quotes, receivables). ' +
        'Visibilidad por rol: ADMIN/MANAGEMENT ven las 5 secciones; SELLER ' +
        've todo salvo lowStock; WAREHOUSE ve únicamente lowStock. Sin ' +
        'período, sales/collections usan el mes calendario actual ' +
        'America/Lima por defecto; lowStock y receivables son de estado ' +
        'ACTUAL y no se filtran por período. NO es contabilidad formal, NO ' +
        'reemplaza los reportes de la etiqueta Reports, y NO constituye una ' +
        'plataforma de Business Intelligence.',
    )
    .addTag(
      'Configuration',
      'Configuración global de la empresa: fila singleton única (identidad, ' +
        'moneda, vigencia por defecto de cotización, descuento máximo ' +
        'configurado e IGV interno del sistema). GET para ADMIN y ' +
        'MANAGEMENT; PATCH solo para ADMIN. taxEnabled/taxRate calculan IGV ' +
        'a nivel de documento sobre precios que siempre se registran ANTES ' +
        'de impuesto (Product.salePrice); NO es facturación electrónica, ' +
        'NO es SUNAT, NO es PLE. Cambiar quoteValidityDays/' +
        'maxDiscountPercent/taxEnabled/taxRate nunca modifica cotizaciones ' +
        'o ventas ya existentes: solo aplica a operaciones comerciales ' +
        'nuevas o efectivamente modificadas desde ese momento. Incluye ' +
        'además la administración de secuencias de documentos ' +
        '(/configuration/sequences: prefix/padding/currentNumber de QUOTE y ' +
        'SALE). GET para ADMIN y MANAGEMENT; PATCH solo para ADMIN. El ' +
        'frontend NUNCA genera ni previsualiza números de documento — no ' +
        'existe ningún endpoint de "próximo número": la única generación es ' +
        'interna, dentro de la transacción de cada cotización/venta. Un ' +
        'cambio de configuración de secuencia afecta solo a los documentos ' +
        'generados desde ese momento; los números ya emitidos son ' +
        'históricos y nunca se modifican. currentNumber puede mantenerse ' +
        'igual o avanzar; nunca puede disminuir respecto del valor actual.',
    )
    .addTag(
      'Electronic Invoicing',
      'Emisión de documentos fiscales (FACTURA/BOLETA) para una venta ya ' +
        'confirmada — un agregado FISCAL separado de Sale, que sigue ' +
        'siendo la única fuente de verdad comercial. La serie fiscal es ' +
        'SIEMPRE explícita (nunca autoseleccionada); solo se admite UN ' +
        'documento fiscal primario por venta (409 ante un segundo intento, ' +
        'sin importar el estado del existente). El reintento ' +
        '(POST /electronic-documents/:id/retry, solo ADMIN) únicamente se ' +
        'admite con el documento en SUBMISSION_FAILED: SUBMITTED puede ' +
        'representar un resultado REMOTO DESCONOCIDO del proveedor (nunca ' +
        'se reintenta automáticamente ni se fuerza un cambio de estado). ' +
        'El proveedor vigente es "MOCK" (integración de demostración): su ' +
        'resultado ACCEPTED es SIMULADO — en ningún caso implica una ' +
        'aceptación real ante SUNAT ni ningún otro ente fiscal. ' +
        'GET /electronic-documents/:id/print (Fase 11, Bloque E) genera en ' +
        'memoria una representación HTML de demostración a partir del ' +
        'snapshot ya persistido — sin PDF, sin QR, sin XML/UBL, sin CDR, ' +
        'sin firma digital, sin archivo almacenado. Sin notas de crédito/ ' +
        'débito, sin proveedor real en este bloque.',
    )
    .addTag(
      'Fiscal Series',
      'Descubrimiento de solo lectura de las series fiscales disponibles ' +
        '(F001/B001 sembradas para esta demo), necesario porque la emisión ' +
        'exige una serie explícita. currentNumber es puramente informativo ' +
        '(último número YA emitido): nunca se expone un "próximo número", ' +
        'que la emisión concurrente podría dejar obsoleto de inmediato. ' +
        'Sin administración (crear/editar/desactivar series) en este ' +
        'bloque.',
    )
    .addTag(
      'Audit',
      'Bitácora de auditoría de solo lectura (Fase 10, Bloque E): quién, ' +
        'qué, cuándo, sobre qué entidad, para las acciones críticas del ' +
        'sistema. GET /audit (paginado, con filtros) y GET /audit/:id, ' +
        'ambos exclusivos para ADMIN y MANAGEMENT; ningún otro rol tiene ' +
        'acceso. Orden fijo: más reciente primero (createdAt descendente, ' +
        'id descendente como desempate). Los filtros de fecha (from/to) ' +
        'usan el día de negocio America/Lima, igual criterio que Reports/ ' +
        'Accounting/Payments. El listado nunca expone metadata ni dirección ' +
        'IP: ambas solo están disponibles en el detalle, y la dirección IP ' +
        'del detalle solo es visible para ADMIN (MANAGEMENT siempre recibe ' +
        'null). No existe ninguna vía de mutación ni de exportación/purga ' +
        'de auditoría; leer esta bitácora nunca genera, a su vez, una nueva ' +
        'entrada de auditoría. No constituye cumplimiento legal/fiscal ni ' +
        'un log técnico de cada request.',
    )
    .build();

  const document = SwaggerModule.createDocument(app, documentConfig);
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    swaggerOptions: { withCredentials: true },
  });

  return true;
}
