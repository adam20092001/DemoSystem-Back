import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupApp } from './app.setup';
import { AppConfigService } from './config/configuration';
import { SWAGGER_PATH, setupSwagger } from './config/swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  setupApp(app);
  const swaggerEnabled = setupSwagger(app);

  const config = app.get<AppConfigService>(ConfigService);
  const port = config.get('PORT', { infer: true });

  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`API disponible en http://localhost:${port}/api/v1`);
  logger.log(`Health check en http://localhost:${port}/api/v1/health`);
  if (swaggerEnabled) {
    logger.log(`Swagger en http://localhost:${port}/${SWAGGER_PATH}`);
  }
}

void bootstrap();
