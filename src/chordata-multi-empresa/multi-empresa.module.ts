import { Global, Module, OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import { EvoExtensionPoints } from '../evo-extension-points';
import { CrmClientModule } from '../shared/crm-client/crm-client.module';
import { EmpresaAcessoService } from './empresa-acesso.service';
import { EmpresaDeFundoService } from './empresa-de-fundo.service';
import { EMPRESA_CLS_KEY, multiEmpresaLigado } from './multi-empresa.constants';
import { MultiEmpresaInterceptor } from './multi-empresa.interceptor';
import { multiEmpresaRunner } from './multi-empresa.runner';

/** Empresa da requisição atual, lida do CLS (vazio fora de uma requisição). */
export function empresaAtualDoCls(): string | undefined {
  try {
    const cls = ClsServiceManager.getClsService();
    return cls.isActive() ? cls.get<string | undefined>(EMPRESA_CLS_KEY) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Multi-empresa do Flow (ADR-0007). DESLIGADO por padrão: sem MULTI_EMPRESA=on o módulo não registra
 * nada e o Flow se comporta como o Evo comunitário. Ligado: troca o ponto de extensão `tenant_db_context`
 * pelo runner com RLS, separa os caches por empresa e envolve cada requisição HTTP na empresa dela.
 */
@Global()
@Module({
  imports: [CrmClientModule],
  providers: [
    EmpresaDeFundoService,
    ...(multiEmpresaLigado()
      ? [
          EmpresaAcessoService,
          { provide: APP_INTERCEPTOR, useClass: MultiEmpresaInterceptor },
        ]
      : []),
  ],
  exports: [EmpresaDeFundoService],
})
export class MultiEmpresaModule implements OnModuleInit {
  onModuleInit(): void {
    if (!multiEmpresaLigado()) return;
    EvoExtensionPoints.replace('tenant_db_context', multiEmpresaRunner);
    EvoExtensionPoints.replace('cache_key_scope', () => {
      const empresa = empresaAtualDoCls();
      return empresa ? `:emp:${empresa}` : '';
    });
  }
}
