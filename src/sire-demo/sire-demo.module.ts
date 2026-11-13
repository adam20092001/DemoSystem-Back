import { DynamicModule, Module } from '@nestjs/common';
import { SIRE_DEMO_FLAGS } from './sire-demo.constants';
import { SireDemoController } from './sire-demo.controller';
import {
  SireDemoFlags,
  resolveSireDemoFlagsFailClosed,
} from './sire-demo.flags';
import { SireDemoBootCheck, SireDemoEnabledGuard } from './sire-demo.guards';
import { SireDemoProposalsService } from './sire-demo-proposals.service';
import { SireDemoService } from './sire-demo.service';
import { FixtureTaxDocumentSource } from './sources/fixture-tax-document.source';
import { PosTaxDocumentSource } from './sources/pos-tax-document.source';

/**
 * Módulo SIRE DEMO (solo demostración; sin comunicación con SUNAT).
 *
 * Registro fail-closed: con el interruptor maestro apagado (por defecto) el
 * módulo queda VACÍO — sin controllers, sin rutas y sin documentación
 * Swagger — salvo el SireDemoBootCheck, que verifica en el arranque que lo
 * montado coincide con la configuración ya validada.
 */
@Module({})
export class SireDemoModule {
  static register(
    flags: SireDemoFlags = resolveSireDemoFlagsFailClosed(process.env),
  ): DynamicModule {
    const base = {
      module: SireDemoModule,
      providers: [
        { provide: SIRE_DEMO_FLAGS, useValue: flags },
        SireDemoBootCheck,
      ],
    };
    if (!flags.enabled) {
      return base;
    }
    return {
      ...base,
      controllers: [SireDemoController],
      providers: [
        ...base.providers,
        SireDemoEnabledGuard,
        SireDemoService,
        SireDemoProposalsService,
        PosTaxDocumentSource,
        FixtureTaxDocumentSource,
      ],
    };
  }
}
