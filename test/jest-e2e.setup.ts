import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { bootstrapVerifiedE2eEnv } from './helpers/e2e-database-target';

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

/**
 * Guardia de base de datos (INC-E2E-database-guard): NO se usa coincidencia de
 * texto sobre DATABASE_URL. Se reevalúa la política estructural compartida
 * (scripts/lib/test-db-guard.js), se exige la huella emitida por
 * jest-e2e.global-setup.ts en esta misma ejecución (que ya verificó la
 * identidad real de la base) y se cargan las variables de .env.test /
 * .env.test.local sin que el shell pueda contradecirlas. Si algo falla, este
 * archivo lanza antes de que exista ningún cliente Prisma o aplicación Nest.
 */
bootstrapVerifiedE2eEnv();
