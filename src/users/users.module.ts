import { Module } from '@nestjs/common';
import { PasswordService } from '../common/security/password.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * AuditService llega desde AuditModule, que es global.
 * PasswordService se exporta para que AuthModule la reutilice sin
 * declarar su propio provider duplicado.
 */
@Module({
  controllers: [UsersController],
  providers: [UsersService, PasswordService],
  exports: [UsersService, PasswordService],
})
export class UsersModule {}
