import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { setupApp } from './../src/app.setup';
import { ErrorResponseDto } from './../src/common/dto/error-response.dto';
import { setupSwagger } from './../src/config/swagger';
import { HealthResponseDto } from './../src/health/dto/health-response.dto';

/**
 * Estas pruebas necesitan el contenedor pos_db levantado (`npm run db:up`).
 * El caso 503 del health check se cubre con mock unitario en health.service.spec.ts,
 * por lo que aquí nunca se detiene PostgreSQL.
 */
describe('API (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    setupApp(app);
    setupSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/v1/health', () => {
    it('responde 200 con la base de datos disponible', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health');

      expect(response.status).toBe(200);

      const body = response.body as HealthResponseDto;
      expect(body.status).toBe('ok');
      expect(body.application).toBe('up');
      expect(body.database).toBe('up');
      expect(typeof body.uptime).toBe('number');
      expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    });

    it('no envuelve la respuesta exitosa en un objeto data', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health');

      expect(Object.keys(response.body as object).sort()).toEqual([
        'application',
        'database',
        'status',
        'timestamp',
        'uptime',
      ]);
    });
  });

  describe('rutas inexistentes', () => {
    it('GET / responde 404 con el formato global de error', async () => {
      const response = await request(app.getHttpServer()).get('/');

      expect(response.status).toBe(404);

      const body = response.body as ErrorResponseDto;
      expect(body.statusCode).toBe(404);
      expect(body.error).toBe('Not Found');
      expect(body.path).toBe('/');
      expect(typeof body.message).toBe('string');
      expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    });

    it('la ruta sin versionar tampoco existe', async () => {
      const response = await request(app.getHttpServer()).get('/api/health');

      expect(response.status).toBe(404);
      expect((response.body as ErrorResponseDto).error).toBe('Not Found');
    });

    it('no expone stack trace ni detalles internos', async () => {
      const response = await request(app.getHttpServer()).get('/');
      const serialized = JSON.stringify(response.body);

      expect(serialized).not.toMatch(/at\s+\w+.*\.ts:/);
      expect(serialized).not.toContain('stack');
    });
  });

  describe('CORS', () => {
    it('permite el origen del frontend con credenciales', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Origin', 'http://localhost:4201');

      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:4201',
      );
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('responde al preflight del frontend', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/v1/health')
        .set('Origin', 'http://localhost:4201')
        .set('Access-Control-Request-Method', 'GET');

      expect(response.status).toBeLessThan(400);
      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:4201',
      );
    });

    it('no autoriza un origen no configurado', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Origin', 'http://localhost:4200');

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('Swagger', () => {
    it('publica el documento OpenAPI cuando SWAGGER_ENABLED=true', async () => {
      const response = await request(app.getHttpServer()).get('/api/docs-json');

      expect(response.status).toBe(200);

      const document = response.body as {
        info: { title: string; version: string };
        paths: Record<string, unknown>;
        components: { securitySchemes: Record<string, unknown> };
      };

      expect(document.info.version).toBe('1.0');
      expect(document.info.title).toContain('DemoSystem');
      expect(document.paths['/api/v1/health']).toBeDefined();
      expect(document.components.securitySchemes.cookieAuth).toBeDefined();
    });

    it('sirve la interfaz en /api/docs', async () => {
      const response = await request(app.getHttpServer()).get('/api/docs');

      expect(response.status).toBeLessThan(400);
    });
  });
});
