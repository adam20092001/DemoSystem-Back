import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ example: 'Temporal1234' })
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @ApiProperty({
    example: 'NuevaClaveSegura2026',
    description:
      'Mínimo 12 caracteres, máximo 128, al menos una letra y un número',
  })
  @IsString()
  @IsNotEmpty()
  newPassword!: string;
}
