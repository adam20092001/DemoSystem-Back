import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { setupApp } from '../../src/app.setup';
import { setupSwagger } from '../../src/config/swagger';
import { assertVerifiedE2eTarget } from './e2e-database-target';

/** Misma configuración exacta que producción (prefijo, guards, filtros, Swagger). */
export async function createE2eApp(): Promise<INestApplication<App>> {
  // Antes de que Nest/PrismaService lean DATABASE_URL del entorno.
  assertVerifiedE2eTarget();
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  setupApp(app);
  setupSwagger(app);
  await app.init();
  return app;
}
