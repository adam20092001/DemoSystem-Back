import { ApiPropertyOptional } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * username, passwordHash, status, mustChangePassword y failedLoginAttempts
 * no se editan por esta vía. roleId nunca se acepta desde el cliente.
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

  @ApiPropertyOptional({ enum: RoleName, example: RoleName.MANAGEMENT })
  @IsOptional()
  @IsEnum(RoleName)
  roleName?: RoleName;
}
