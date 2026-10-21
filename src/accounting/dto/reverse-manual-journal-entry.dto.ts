import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ReverseManualJournalEntryDto {
  @ApiProperty({
    maxLength: 200,
    description: 'Motivo obligatorio de la reversión.',
    example: 'Error en la cuenta destino del ajuste',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason!: string;
}
