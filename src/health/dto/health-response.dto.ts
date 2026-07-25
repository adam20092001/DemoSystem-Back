import { ApiProperty } from '@nestjs/swagger';

export type ComponentStatus = 'up' | 'down';
export type OverallStatus = 'ok' | 'error';

/** Respuesta del health check. No expone credenciales ni errores del motor. */
export class HealthResponseDto {
  @ApiProperty({
    example: 'ok',
    enum: ['ok', 'error'],
    description: 'Resultado global: ok solo si todos los componentes responden',
  })
  status!: OverallStatus;

  @ApiProperty({
    example: 'up',
    enum: ['up', 'down'],
    description: 'Estado del proceso de la aplicación',
  })
  application!: ComponentStatus;

  @ApiProperty({
    example: 'up',
    enum: ['up', 'down'],
    description: 'Estado de PostgreSQL, comprobado con SELECT 1',
  })
  database!: ComponentStatus;

  @ApiProperty({
    example: 1284,
    description: 'Segundos transcurridos desde el arranque del proceso',
  })
  uptime!: number;

  @ApiProperty({
    example: '2026-07-24T22:15:30.123Z',
    description: 'Momento de la comprobación (ISO 8601)',
  })
  timestamp!: string;
}
