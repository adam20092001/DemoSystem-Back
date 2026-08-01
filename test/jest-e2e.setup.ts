import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Se ejecuta antes de cada archivo e2e (jest "setupFiles"). Fuerza NODE_ENV
 * y precarga .env.test en process.env ANTES de que AppModule inicialice
 * ConfigModule.
 *
 * ConfigModule.forRoot() nunca sobrescribe una variable ya presente en
 * process.env con el contenido de su envFilePath ('.env'), así que con esto
 * basta para que toda la app (incluido Prisma) apunte a pos_db_test sin
 * tocar ninguna ruta de producción ni añadir condicionales de entorno al
 * código de la aplicación.
 */
process.env.NODE_ENV = 'test';

/**
 * Carpeta exclusiva de imágenes para este archivo de prueba: ruta bajo el
 * directorio temporal del sistema operativo, nunca dentro de PRODUCT_UPLOAD_DIR
 * de desarrollo. Deliberadamente NO se crea aquí (mkdir): LocalDiskImageStorageService
 * la crea bajo demanda solo si el archivo de prueba realmente sube una imagen,
 * así los archivos que no tocan imágenes no dejan ningún directorio huérfano.
 */
process.env.PRODUCT_UPLOAD_DIR = resolve(
  tmpdir(),
  `demosystem-e2e-uploads-${process.pid}-${randomUUID()}`,
);

const result = config({ path: resolve(__dirname, '../.env.test') });

if (result.error) {
  throw new Error(
    'No se pudo cargar .env.test. Copia .env.test.example a .env.test ' +
      `antes de ejecutar las pruebas e2e. Detalle: ${result.error.message}`,
  );
}

if (!process.env.DATABASE_URL?.includes('pos_db_test')) {
  throw new Error(
    'DATABASE_URL de .env.test no apunta a pos_db_test. Abortando para no ' +
      'arriesgar datos de otra base.',
  );
}
