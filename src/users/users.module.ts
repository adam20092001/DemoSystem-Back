import { Module } from '@nestjs/common';
import { PasswordService } from '../common/security/password.service';
import { RolesController } from './roles.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * AuditService llega desde AuditModule, que es global.
 * PasswordService se exporta para que AuthModule la reutilice sin
 * declarar su propio provider duplicado.
 *
 * RolesController (GET /roles, catálogo de RoleName para el selector de
 * Angular) reutiliza este mismo módulo y UsersService.listRoles() — nunca
 * un módulo nuevo para un endpoint de solo lectura sobre el mismo enum que
 * ya administra UsersController.
 */
@Module({
  controllers: [UsersController, RolesController],
  providers: [UsersService, PasswordService],
  exports: [UsersService, PasswordService],
})
export class UsersModule {}
