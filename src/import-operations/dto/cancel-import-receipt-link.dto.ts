import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CancelImportReceiptLinkDto {
  @ApiProperty({ maxLength: 300 })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;
}
