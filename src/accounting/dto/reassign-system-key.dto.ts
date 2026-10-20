import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ReassignSystemKeyDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Cuenta que pasará a sostener este systemKey. Debe existir, estar ACTIVE, ser postable y no tener ya otro systemKey.',
  })
  @IsUUID()
  accountId!: string;
}
