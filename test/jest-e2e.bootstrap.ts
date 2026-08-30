import { ensureActiveTestAdmin } from './helpers/fixtures';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Bootstrap CENTRAL de cada archivo e2e (Fase 12E).
 *
 * Registrado vía `setupFilesAfterEnv` (no `setupFiles`): a diferencia de
 * jest-e2e.setup.ts (que solo carga variables de entorno antes de que el
 * framework de pruebas exista), este archivo se ejecuta DESPUÉS de que
 * `describe`/`it`/`beforeAll` ya están disponibles, así que puede registrar
 * un `beforeAll()` de nivel raíz. Jest ejecuta los hooks de nivel raíz antes
 * que los `beforeAll` anidados dentro de cualquier `describe` del propio
 * archivo — así que esto corre ANTES del `beforeAll` local de cada spec.
 *
 * Como `setupFilesAfterEnv` se reevalúa una vez por cada archivo de prueba
 * (Jest aísla el registro de módulos por archivo), este `beforeAll` se
 * registra — y por tanto se ejecuta — para los 26 archivos `*.e2e-spec.ts`
 * por igual, sin que ninguno tenga que recordar invocarlo.
 *
 * Qué resuelve exactamente (Fase 12D, hallazgo bloqueante de release):
 * antes de esta ronda, `ensureActiveTestAdmin()` solo se invocaba desde
 * users.e2e-spec.ts y users-admin-concurrency.e2e-spec.ts — dos archivos
 * que ordenan alfabéticamente AL FINAL — mientras que cerca de 24 archivos
 * más asumían implícitamente, sin nunca establecerlo ellos mismos, que el
 * admin sembrado ya estaba en estado "activo" (contraseña ya cambiada,
 * mustChangePassword=false). Contra una pos_db_test genuinamente vacía
 * (recién arreglado en la Fase 12B: antes, `db:test:down:clean` nunca
 * llegaba a borrar el volumen de verdad), esa dependencia de orden nunca se
 * cumplía y casi toda la suite fallaba en cascada.
 *
 * Con este bootstrap, CUALQUIER archivo puede ejecutarse de forma aislada,
 * en cualquier orden, inmediatamente después de `npm run db:test:reset` —
 * ningún archivo depende de que otro haya corrido antes. Además,
 * `ensureActiveTestAdmin()` ahora es un upsert (Fase 12E): si el admin
 * sembrado hubiera sido eliminado por un efecto colateral de otro archivo
 * (ver hallazgo de limpieza no acotada corregido en la misma ronda), este
 * bootstrap lo recrea en vez de fallar.
 *
 * Nunca crea AuditLog (usa Prisma directo, no AuditService, igual que el
 * resto de test/helpers/fixtures.ts) y nunca relaja la política de
 * contraseñas real ni el contrato mustChangePassword=true del seed de
 * producción — ver el docblock de ensureActiveTestAdmin().
 */
beforeAll(async () => {
  const prisma = createTestPrismaClient();
  try {
    await ensureActiveTestAdmin(prisma);
  } finally {
    await prisma.$disconnect();
  }
});
