import { ApiPropertyOptional } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * username, passwordHash, status, mustChangePassword y failedLoginAttempts
 * no se editan por esta vía. roleId(s) nunca se aceptan desde el cliente.
 * KAN-18, Bloque A: roleName (singular) se reemplaza por roleNames, con
 * semántica de REEMPLAZO TOTAL — si se envía, el conjunto de roles
 * asignados pasa a ser exactamente ese arreglo (nunca add/remove
 * incremental). Si se omite, los roles asignados no cambian.
 */
export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'Juan Carlos', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Pérez Gómez', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string;

  @ApiPropertyOptional({ example: 'nuevo@demosystem.local', maxLength: 150 })
  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  email?: string;

  @ApiPropertyOptional({
    enum: RoleName,
    isArray: true,
    example: [RoleName.MANAGEMENT, RoleName.WAREHOUSE],
    description:
      'Reemplaza TOTALMENTE el conjunto de roles asignados. Sin duplicados; mínimo uno. Omitir el campo conserva los roles actuales.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(RoleName, { each: true })
  roleNames?: RoleName[];
}
