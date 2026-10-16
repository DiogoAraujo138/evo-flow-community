import { Global, Logger, Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import { EvoExtensionPoints } from '../evo-extension-points';
import { ClickHouseEmpresa } from './clickhouse-empresa';
import { ExecucaoPorEmpresa } from './por-empresa';
import { FonteDeEmpresas } from './fonte-de-empresas';
import { usarTransacaoDaEmpresaNosRepositorios } from './temporal';
import { CrmClientModule } from '../shared/crm-client/crm-client.module';
import { EmpresaAcessoService } from './empresa-acesso.service';
import { EmpresaDeFundoService } from './empresa-de-fundo.service';
import { WebhookEmpresaService } from './webhook-empresa.service';
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
    WebhookEmpresaService,
    ...(multiEmpresaLigado()
      ? [
          EmpresaAcessoService,
          { provide: APP_INTERCEPTOR, useClass: MultiEmpresaInterceptor },
        ]
      : []),
  ],
  exports: [EmpresaDeFundoService, WebhookEmpresaService],
})
export class MultiEmpresaModule implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(MultiEmpresaModule.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly fundo: EmpresaDeFundoService,
  ) {}

  /** Depois de todos os onModuleInit (o ClickHouseService já se registrou): prepara o banco de cada empresa ativa. */
  async onApplicationBootstrap(): Promise<void> {
    if (!multiEmpresaLigado()) return;
    usarTransacaoDaEmpresaNosRepositorios();
    FonteDeEmpresas.configurar(this.dataSource);
    ClickHouseEmpresa.definirBuscaDeSlug(async id => {
      const linhas = await FonteDeEmpresas.consultar<{ slug: string }>(
        'SELECT slug FROM empresas WHERE id = $1 AND ativa',
        [id],
      );
      return linhas[0]?.slug ?? null;
    });
    const empresas = await FonteDeEmpresas.consultar<{ id: string; slug: string }>(
      'SELECT id, slug FROM empresas WHERE ativa ORDER BY nome',
    );
    ExecucaoPorEmpresa.configurar(this.fundo, async () => {
      const ativas = await FonteDeEmpresas.consultar<{ id: string; slug: string }>(
        'SELECT id, slug FROM empresas WHERE ativa ORDER BY nome',
      );
      return ativas;
    });
    for (const e of empresas) {
      await ClickHouseEmpresa.garantir(e.id, e.slug);
      this.logger.log(`Banco de eventos da empresa ${e.slug} pronto`);
    }
  }

  onModuleInit(): void {
    if (!multiEmpresaLigado()) return;
    EvoExtensionPoints.replace('tenant_db_context', multiEmpresaRunner);
    EvoExtensionPoints.replace('cache_key_scope', () => {
      const empresa = empresaAtualDoCls();
      return empresa ? `:emp:${empresa}` : '';
    });
  }
}
