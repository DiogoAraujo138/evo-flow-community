import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { ClsServiceManager } from 'nestjs-cls';
import { EMPRESA_CLS_KEY } from './multi-empresa.constants';
import { ExecucaoPorEmpresa } from './por-empresa';
import { interceptadoresDoClienteTemporal, opcoesTemporalDoWorker } from './temporal';

/**
 * Integração com um servidor Temporal REAL de desenvolvimento (container `temporalio/temporal server start-dev`).
 * Só roda com TEMPORAL_TEST_ADDRESS (ex.: temporal-teste:7233).
 */
const ENDERECO = process.env.TEMPORAL_TEST_ADDRESS;
const d = ENDERECO ? describe : describe.skip;
jest.setTimeout(180_000);

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// O bundler de workflows do Temporal usa swc (binário nativo); aqui transpilamos antes para JS puro.
const PASTA = join(process.cwd(), '.tmp-temporal-teste');
function transpilar(origem: string, destino: string): string {
  const js = transpileModule(readFileSync(origem, 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
  }).outputText;
  const saida = join(PASTA, destino);
  writeFileSync(saida, js);
  return saida;
}

d('Temporal: a empresa chega do cliente até a atividade (servidor real)', () => {
  let worker: Worker;
  let rodando: Promise<void>;
  let connection: Connection;
  const cls = ClsServiceManager.getClsService();

  beforeAll(async () => {
    process.env.MULTI_EMPRESA = 'on';
    // o "executor de fundo" do teste: fixa a empresa no CLS enquanto a atividade roda
    ExecucaoPorEmpresa.configurar(
      {
        executarNaEmpresa: (id, trabalho) =>
          cls.run(async () => {
            cls.set(EMPRESA_CLS_KEY, id);
            return trabalho();
          }),
      },
      null,
    );
    mkdirSync(PASTA, { recursive: true });
    const workflowTeste = transpilar(require.resolve('./teste-temporal/eco.workflow'), 'eco.workflow.js');
    const interceptadores = transpilar(require.resolve('../modules/temporal/workflows/empresa-interceptors'), 'empresa-interceptors.js');
    const nativa = await NativeConnection.connect({ address: ENDERECO! });
    worker = await Worker.create({
      connection: nativa,
      taskQueue: 'teste-empresa',
      workflowsPath: workflowTeste,
      activities: { qualEmpresa: async () => (cls.isActive() ? (cls.get(EMPRESA_CLS_KEY) ?? null) : null) },
      ...opcoesTemporalDoWorker(interceptadores),
    });
    rodando = worker.run();
    connection = await Connection.connect({ address: ENDERECO! });
  });

  afterAll(async () => {
    worker?.shutdown();
    await rodando?.catch(() => undefined);
    await connection?.close();
    rmSync(PASTA, { recursive: true, force: true });
  });

  const iniciarComo = (empresa: string | null) => {
    const client = new Client({ connection, interceptors: interceptadoresDoClienteTemporal() });
    return cls.run(async () => {
      if (empresa) cls.set(EMPRESA_CLS_KEY, empresa);
      return client.workflow.execute('EcoEmpresaWorkflow', { taskQueue: 'teste-empresa', workflowId: `eco-${randomUUID()}` });
    });
  };

  it('a atividade enxerga a empresa de quem iniciou o workflow', async () => {
    expect(await iniciarComo(A)).toBe(A);
    expect(await iniciarComo(B)).toBe(B);
  });

  it('sem empresa no cliente, a atividade também não tem empresa (falha segura)', async () => {
    expect(await iniciarComo(null)).toBeNull();
  });
});
