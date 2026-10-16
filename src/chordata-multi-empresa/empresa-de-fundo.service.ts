import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { DataSource } from 'typeorm';
import { EvoExtensionPoints } from '../evo-extension-points';
import { TENANT_DB_MANAGER_CLS_KEY } from '../evo-extension-points/tenant-db-context/tenant-db-context.types';
import { EMPRESA_CLS_KEY, multiEmpresaLigado } from './multi-empresa.constants';
import { EmpresaAusenteError } from './multi-empresa.runner';

/**
 * Empresa para o que roda FORA de uma requisição HTTP (consumidores de fila, tarefas agendadas): lá não há
 * cabeçalho nem usuário, então a empresa sai do próprio dado (ex.: a campanha da mensagem). Desligado, só
 * executa o trabalho, sem mudar nada.
 */
@Injectable()
export class EmpresaDeFundoService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cls: ClsService,
  ) {}

  /** Roda `trabalho` na transação da empresa, com o repositório e o CRM já na empresa certa. */
  executarNaEmpresa<T>(empresaId: string | null | undefined, trabalho: () => Promise<T>): Promise<T> {
    if (!multiEmpresaLigado()) return trabalho();
    return this.cls.run(async () => {
      const runner = EvoExtensionPoints.get('tenant_db_context');
      return runner(this.dataSource, empresaId ?? null, async manager => {
        this.cls.set(TENANT_DB_MANAGER_CLS_KEY, manager);
        this.cls.set(EMPRESA_CLS_KEY, empresaId);
        return trabalho();
      });
    });
  }

  /** Descobre a empresa de uma campanha pelo id (função do banco, sem escopo) e roda o trabalho nela. */
  async executarParaCampanha<T>(campaignId: string, trabalho: () => Promise<T>): Promise<T> {
    if (!multiEmpresaLigado()) return trabalho();
    const linhas: Array<{ empresa: string | null }> = await this.dataSource.query(
      'SELECT chordata_resolver_empresa($1, $2, $3) AS empresa',
      ['campaigns', 'id', campaignId],
    );
    const empresa = linhas[0]?.empresa ?? null;
    if (!empresa) throw new EmpresaAusenteError(); // campanha inexistente: erro explícito, nunca "sem escopo"
    return this.executarNaEmpresa(empresa, trabalho);
  }
}
