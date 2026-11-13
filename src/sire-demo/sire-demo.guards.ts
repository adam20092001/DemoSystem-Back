import {
  CanActivate,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  PipeTransform,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SIRE_REGISTERS } from './core/types';
import type { SireRegister } from './core/types';
import { SIRE_DEMO_FLAGS } from './sire-demo.constants';
import { resolveSireDemoFlags } from './sire-demo.flags';
import type { SireDemoFlags } from './sire-demo.flags';

/**
 * Segunda línea de defensa: con el módulo normalmente AUSENTE (registro
 * condicional), este guard solo actúa si alguna vez el controller quedara
 * montado con el interruptor maestro apagado. Responde 404, igual que una
 * ruta inexistente.
 */
@Injectable()
export class SireDemoEnabledGuard implements CanActivate {
  constructor(@Inject(SIRE_DEMO_FLAGS) private readonly flags: SireDemoFlags) {}

  canActivate(): boolean {
    if (!this.flags.enabled) {
      throw new NotFoundException();
    }
    return true;
  }
}

/**
 * Verificación AUTORITATIVA del arranque, posterior a ConfigModule: compara
 * lo que se montó (decidido al registrar el módulo) con la configuración ya
 * validada por validateEnv. Cualquier discrepancia aborta el arranque
 * (fail-closed y determinista): nunca queda un módulo montado que la
 * configuración validada no autoriza, ni uno ausente que sí se pidió.
 */
@Injectable()
export class SireDemoBootCheck implements OnModuleInit {
  private readonly logger = new Logger(SireDemoBootCheck.name);

  constructor(
    @Inject(SIRE_DEMO_FLAGS) private readonly mounted: SireDemoFlags,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const configured = resolveSireDemoFlags({
      NODE_ENV: this.config.get('NODE_ENV'),
      SIRE_DEMO_ENABLED: this.config.get('SIRE_DEMO_ENABLED'),
      SIRE_DEMO_FIXTURES_ENABLED: this.config.get('SIRE_DEMO_FIXTURES_ENABLED'),
      SIRE_DEMO_ALLOW_IN_PRODUCTION: this.config.get(
        'SIRE_DEMO_ALLOW_IN_PRODUCTION',
      ),
    });

    if (
      configured.enabled !== this.mounted.enabled ||
      configured.fixturesEnabled !== this.mounted.fixturesEnabled
    ) {
      throw new Error(
        'SIRE DEMO: el módulo se registró con flags distintos de la configuración validada ' +
          `(registrado enabled=${this.mounted.enabled}/fixtures=${this.mounted.fixturesEnabled}; ` +
          `configurado enabled=${configured.enabled}/fixtures=${configured.fixturesEnabled}). ` +
          'Define las variables SIRE_DEMO_* en el entorno del proceso o en .env antes de arrancar.',
      );
    }

    if (this.mounted.enabled && this.mounted.production) {
      this.logger.warn(
        'SIRE DEMO habilitado con NODE_ENV=production (SIRE_DEMO_ALLOW_IN_PRODUCTION=true). Es solo una demostración, sin validez ante SUNAT.',
      );
    }
  }
}

/** :register acepta rvie/rce en cualquier capitalización. */
export class ParseSireRegisterPipe implements PipeTransform<
  string,
  SireRegister
> {
  transform(value: string): SireRegister {
    const upper = String(value).toUpperCase();
    if (!(SIRE_REGISTERS as readonly string[]).includes(upper)) {
      throw new BadRequestException('register debe ser rvie o rce');
    }
    return upper as SireRegister;
  }
}
