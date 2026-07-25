import { Module } from '@nestjs/common';
import { PasswordService } from '../common/security/password.service';
import { UsersService } from './users.service';

/** AuditService llega desde AuditModule, que es global. */
@Module({
  providers: [UsersService, PasswordService],
  exports: [UsersService],
})
export class UsersModule {}
