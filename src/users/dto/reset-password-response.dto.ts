import { ApiProperty } from '@nestjs/swagger';
import { UserResponseDto } from './user-response.dto';

/** temporaryPassword solo aparece aquí, una única vez, y nunca se audita ni registra. */
export class ResetPasswordResponseDto {
  @ApiProperty({ type: UserResponseDto })
  user!: UserResponseDto;

  @ApiProperty({ example: 'Xk7pQ2mZwT9fR4nB' })
  temporaryPassword!: string;
}
