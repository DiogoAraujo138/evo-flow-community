import { defaultPayloadConverter } from '@temporalio/common';
import type { Next } from '@temporalio/common';
import type { WorkflowClientInterceptor } from '@temporalio/client';
import type { ActivityExecuteInput, ActivityInboundCallsInterceptor } from '@temporalio/worker';
import { DataSource } from 'typeorm';
import { ClsServiceManager } from 'nestjs-cls';
import { TENANT_DB_MANAGER_CLS_KEY } from '../evo-extension-points/tenant-db-context/tenant-db-context.types';
import { multiEmpresaLigado } from './multi-empresa.constants';
import { ExecucaoPorEmpresa } from './por-empresa';
import { empresaAtualDoCls } from './multi-empresa.module';

/** Cabeçalho do Temporal que leva a empresa: cliente -> workflow -> atividade. */
export const EMPRESA_HEADER_TEMPORAL = 'x-evo-tenant-id';

/**
 * CLIENTE: quem inicia o workflow (API, gatilho de jornada) marca a empresa corrente no cabeçalho. Sem empresa
 * no contexto não marca nada e a atividade falha fechada (RLS) em vez de adivinhar.
 */
export class EmpresaClientInterceptor implements WorkflowClientInterceptor {
  private cabecalhos<T extends { headers: Record<string, unknown> }>(input: T): T {
    const empresa = empresaAtualDoCls();
    if (!empresa) return input;
    return {
      ...input,
      headers: { ...input.headers, [EMPRESA_HEADER_TEMPORAL]: defaultPayloadConverter.toPayload(empresa) },
    };
  }

  async start(input: any, next: any) {
    return next(this.cabecalhos(input));
  }

  async signalWithStart(input: any, next: any) {
    return next(this.cabecalhos(input));
  }
}

/** Para `new Client({ interceptors })`; `undefined` com multi-empresa desligado (nada muda). */
export function interceptadoresDoClienteTemporal(): { workflow: WorkflowClientInterceptor[] } | undefined {
  return multiEmpresaLigado() ? { workflow: [new EmpresaClientInterceptor()] } : undefined;
}

/**
 * ATIVIDADE: lê a empresa do cabeçalho e roda a atividade na transação dela (RLS, ClickHouse e cache da empresa).
 * Sem cabeçalho a atividade segue sem empresa e o banco não devolve nada.
 */
export class EmpresaActivityInbound implements ActivityInboundCallsInterceptor {
  async execute(input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>) {
    const bruto = input.headers?.[EMPRESA_HEADER_TEMPORAL];
    const empresa = bruto ? defaultPayloadConverter.fromPayload<string>(bruto) : null;
    const fundo = ExecucaoPorEmpresa.fundo;
    if (!empresa || !fundo) return next(input);
    return fundo.executarNaEmpresa(empresa, () => next(input));
  }
}

/** Opções extras do `Worker.create` (workflows + atividades); vazio com multi-empresa desligado. */
export function opcoesTemporalDoWorker(caminhoInterceptadoresDeWorkflow: string): Record<string, unknown> {
  if (!multiEmpresaLigado()) return {};
  return {
    interceptors: {
      workflowModules: [caminhoInterceptadoresDeWorkflow],
      activity: [() => ({ inbound: new EmpresaActivityInbound() })],
    },
  };
}

let repositorioPatchado = false;

/**
 * As atividades pegam repositórios direto do DataSource (`dataSource.getRepository(...)`), fora do seam do
 * Flow. Com multi-empresa, se há uma transação da empresa no contexto (a que a atividade acabou de abrir),
 * o repositório vem DELA: assim RLS vale também para esse código, sem editar cada atividade.
 */
export function usarTransacaoDaEmpresaNosRepositorios(): void {
  if (repositorioPatchado || !multiEmpresaLigado()) return;
  repositorioPatchado = true;
  const original = DataSource.prototype.getRepository;
  DataSource.prototype.getRepository = function (this: DataSource, alvo: any) {
    try {
      const cls = ClsServiceManager.getClsService();
      const manager = cls.isActive() ? cls.get<{ getRepository: (a: unknown) => unknown } | undefined>(TENANT_DB_MANAGER_CLS_KEY) : undefined;
      if (manager) return manager.getRepository(alvo) as never;
    } catch {
      /* sem CLS: segue o caminho normal */
    }
    return original.call(this, alvo);
  } as typeof original;
}
