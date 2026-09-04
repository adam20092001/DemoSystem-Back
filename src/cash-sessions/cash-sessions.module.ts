import { Module } from '@nestjs/common';
import { CashSessionsController } from './cash-sessions.controller';
import { CashSessionsService } from './cash-sessions.service';

/** PrismaService y AuditService llegan de módulos globales (Database, Audit), mismo criterio que PaymentMethodsModule. */
@Module({
  controllers: [CashSessionsController],
  providers: [CashSessionsService],
})
export class CashSessionsModule {}
