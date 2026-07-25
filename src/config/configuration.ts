import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from './env.validation';

/**
 * ConfigService tipado contra EnvironmentVariables.
 *
 * Al estar validadas todas las claves durante el arranque, se usa `true` como
 * segundo parámetro para que `get()` devuelva el valor sin `undefined`.
 *
 * Uso: `constructor(private readonly config: AppConfigService) {}`
 */
export type AppConfigService = ConfigService<EnvironmentVariables, true>;
