import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/** PrismaService llega desde DatabaseModule, que es global. */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
