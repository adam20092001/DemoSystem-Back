import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * El archivo binario llega por el campo multipart "file" (@UploadedFile()),
 * fuera de este DTO. sortOrder es el único campo de texto opcional del
 * formulario. El binario se documenta aparte en @ApiBody del controller.
 */
export class CreateProductImageDto {
  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
