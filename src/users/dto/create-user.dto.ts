import { ApiProperty } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../common/security/password-policy';

/**
 * roleId nunca se acepta desde el cliente: el rol se resuelve en el servicio
 * a partir de roleName. actorUserId e ipAddress los provee el controller.
 */
export class CreateUserDto {
  @ApiProperty({ example: 'Juan', maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  firstName!: string;

  @ApiProperty({ example: 'Pérez', maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  lastName!: string;

  @ApiProperty({ example: 'jperez', minLength: 3, maxLength: 50 })
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  username!: string;

  @ApiProperty({ example: 'jperez@demosystem.local', maxLength: 150 })
  @IsEmail()
  @MaxLength(150)
  email!: string;

  @ApiProperty({
    example: 'Temporal1234',
    description: `Mínimo ${PASSWORD_MIN_LENGTH} caracteres, máximo ${PASSWORD_MAX_LENGTH}, al menos una letra y un número`,
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(/(?=.*[a-zA-Z])(?=.*[0-9])/, {
    message: 'temporaryPassword debe incluir al menos una letra y un número',
  })
  temporaryPassword!: string;

  @ApiProperty({ enum: RoleName, example: RoleName.SELLER })
  @IsEnum(RoleName)
  roleName!: RoleName;
}
