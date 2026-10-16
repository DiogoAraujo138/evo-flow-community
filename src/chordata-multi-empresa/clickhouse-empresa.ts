import { AsyncLocalStorage } from 'node:async_hooks';
import type { ClickHouseClient } from '@clickhouse/client';
import { empresaAtualDoCls } from './multi-empresa.module';
import { multiEmpresaLigado, UUID_RE } from './multi-empresa.constants';

/** O que o registro precisa do ClickHouseService (evita import circular com o módulo de processamento). */
export interface ServicoClickHouse {
  criarClienteParaBanco(banco: string): ClickHouseClient;
  prepararBanco(banco: string): Promise<void>;
}

/** Como achar o slug de uma empresa (tabela sem RLS). */
export type BuscarSlug = (empresaId: string) => Promise<string | null>;

export const SLUG_PADRAO = 'padrao';

/** `padrao` mantém o banco que já existe (com os eventos atuais); as demais ganham `evo_campaign_<slug>`. */
export function nomeDoBanco(slug: string): string {
  if (slug === SLUG_PADRAO) return process.env.CLICKHOUSE_DATABASE || 'evo_campaign';
  const limpo = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!limpo) throw new Error(`slug de empresa inválido para nome de banco: ${JSON.stringify(slug)}`);
  return `evo_campaign_${limpo}`;
}

/**
 * ClickHouse isolado por empresa: um BANCO por empresa. O cliente de cada banco já nasce apontando para ele, então
 * as consultas sem nome de banco (a imensa maioria) caem sempre na empresa certa. O cliente base fica no banco
 * `default`: consulta de dado sem empresa falha ("tabela não existe") em vez de ler a empresa errada.
 * Só suporta gravação síncrona e fila direta (WRITE_MODE=ch-sync, QUEUE_MODE=direct): os caminhos por Kafka não
 * carregam a empresa (ver runbook).
 */
export class ClickHouseEmpresa {
  private static servico: ServicoClickHouse | null = null;
  private static buscarSlug: BuscarSlug | null = null;
  private static clientes = new Map<string, { banco: string; cliente: ClickHouseClient }>();
  private static emPreparo = new Map<string, Promise<void>>();
  private static preparando = new AsyncLocalStorage<true>();
  /** Troca nos testes; em produção é o CLS da requisição/tarefa. */
  static empresaAtual: () => string | undefined = empresaAtualDoCls;

  static configurar(servico: ServicoClickHouse | null): void {
    this.servico = servico;
  }

  static definirBuscaDeSlug(buscarSlug: BuscarSlug): void {
    this.buscarSlug = buscarSlug;
  }

  static reiniciarParaTestes(): void {
    this.servico = null;
    this.buscarSlug = null;
    this.clientes.clear();
    this.emPreparo.clear();
    this.empresaAtual = empresaAtualDoCls;
  }

  static exigirModosCompativeis(env: NodeJS.ProcessEnv = process.env): void {
    if (env.WRITE_MODE !== 'ch-sync' || env.QUEUE_MODE !== 'direct') {
      throw new Error(
        'Multi-empresa exige WRITE_MODE=ch-sync e QUEUE_MODE=direct: os caminhos por Kafka/fila ainda não carregam a empresa.',
      );
    }
  }

  /** Prepara (idempotente) o banco da empresa. Chamado fora do caminho quente: no boot e ao ver uma empresa nova. */
  static async garantir(empresaId: string, slugConhecido?: string): Promise<void> {
    if (!multiEmpresaLigado() || !this.servico) return;
    if (!UUID_RE.test(empresaId)) throw new Error('empresa inválida');
    if (this.clientes.has(empresaId)) return;
    let preparo = this.emPreparo.get(empresaId);
    if (!preparo) {
      preparo = (async () => {
        const slug = slugConhecido ?? (await this.buscarSlug?.(empresaId));
        if (!slug) throw new Error(`empresa ${empresaId} sem slug: não dá para escolher o banco de eventos`);
        const banco = nomeDoBanco(slug);
        await this.semEscolhaPorEmpresa(() => this.servico!.prepararBanco(banco));
        this.clientes.set(empresaId, { banco, cliente: this.servico!.criarClienteParaBanco(banco) });
      })().finally(() => this.emPreparo.delete(empresaId));
      this.emPreparo.set(empresaId, preparo);
    }
    await preparo;
  }

  /** Roda o preparo de um banco SEM escolher cliente/banco pela empresa corrente (o DDL fala do banco alvo). */
  static semEscolhaPorEmpresa<T>(trabalho: () => Promise<T>): Promise<T> {
    return this.preparando.run(true, trabalho);
  }

  /**
   * O código do Flow escreve `evo_campaign.<tabela>` em ~15 consultas (módulo de segmentos). Com multi-empresa o
   * prefixo vira o banco da empresa corrente, num ponto só (query/command/insert do ClickHouseService).
   */
  static reescrever(sql: string): string {
    const banco = this.bancoAtual();
    if (!banco || banco === 'evo_campaign') return sql;
    return sql.replace(/\bevo_campaign\.(?=[a-z_])/g, `${banco}.`);
  }

  private static entradaAtual(): { banco: string; cliente: ClickHouseClient } | null {
    if (!multiEmpresaLigado() || this.preparando.getStore()) return null;
    const empresa = this.empresaAtual();
    if (!empresa) return null;
    const entrada = this.clientes.get(empresa);
    if (!entrada) {
      throw new Error(`banco de eventos da empresa ${empresa} não está preparado (garantir() não rodou)`);
    }
    return entrada;
  }

  /** Cliente da empresa corrente, ou null (desligado / sem empresa: usa o cliente base, sem dados). */
  static clienteAtual(): ClickHouseClient | null {
    return this.entradaAtual()?.cliente ?? null;
  }

  /** Banco da empresa corrente, ou null. */
  static bancoAtual(): string | null {
    return this.entradaAtual()?.banco ?? null;
  }

  static async fechar(): Promise<void> {
    await Promise.all([...this.clientes.values()].map(e => e.cliente.close().catch(() => undefined)));
    this.clientes.clear();
  }
}
