import { defaultPayloadConverter } from '@temporalio/common';
import { ClsServiceManager } from 'nestjs-cls';
import { EMPRESA_CLS_KEY } from './multi-empresa.constants';
import { ExecucaoPorEmpresa } from './por-empresa';
import {
  EMPRESA_HEADER_TEMPORAL,
  EmpresaActivityInbound,
  EmpresaClientInterceptor,
  interceptadoresDoClienteTemporal,
  opcoesTemporalDoWorker,
} from './temporal';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Temporal e multi-empresa', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    ExecucaoPorEmpresa.configurar(null, null);
  });

  it('desligado, não acrescenta nada', () => {
    delete process.env.MULTI_EMPRESA;
    expect(interceptadoresDoClienteTemporal()).toBeUndefined();
    expect(opcoesTemporalDoWorker('/x')).toEqual({});
  });

  it('ligado, registra os interceptadores do cliente e do worker', () => {
    process.env.MULTI_EMPRESA = 'on';
    expect(interceptadoresDoClienteTemporal()?.workflow).toHaveLength(1);
    const o = opcoesTemporalDoWorker('/caminho') as { interceptors: { workflowModules: string[]; activity: unknown[] } };
    expect(o.interceptors.workflowModules).toEqual(['/caminho']);
    expect(o.interceptors.activity).toHaveLength(1);
  });

  it('o cliente marca a empresa corrente no cabeçalho ao iniciar o workflow', async () => {
    const cls = ClsServiceManager.getClsService();
    const next = jest.fn(async (i: unknown) => i);
    await cls.run(async () => {
      cls.set(EMPRESA_CLS_KEY, A);
      const saida: any = await new EmpresaClientInterceptor().start({ headers: { outro: 1 } }, next);
      expect(defaultPayloadConverter.fromPayload(saida.headers[EMPRESA_HEADER_TEMPORAL])).toBe(A);
      expect(saida.headers.outro).toBe(1);
    });
  });

  it('o cliente sem empresa no contexto não inventa cabeçalho', async () => {
    const next = jest.fn(async (i: unknown) => i);
    const saida: any = await new EmpresaClientInterceptor().start({ headers: {} }, next);
    expect(saida.headers[EMPRESA_HEADER_TEMPORAL]).toBeUndefined();
  });

  it('a atividade roda dentro da empresa do cabeçalho', async () => {
    const vistas: string[] = [];
    ExecucaoPorEmpresa.configurar(
      { executarNaEmpresa: async (id, trabalho) => { vistas.push(String(id)); return trabalho(); } },
      null,
    );
    const next = jest.fn(async () => 'resultado');
    const headers = { [EMPRESA_HEADER_TEMPORAL]: defaultPayloadConverter.toPayload(A) };
    const r = await new EmpresaActivityInbound().execute({ headers, args: [] } as never, next as never);
    expect(r).toBe('resultado');
    expect(vistas).toEqual([A]);
  });

  it('a atividade sem cabeçalho segue sem empresa (o banco não devolve nada)', async () => {
    const executar = jest.fn();
    ExecucaoPorEmpresa.configurar({ executarNaEmpresa: executar } as never, null);
    const next = jest.fn(async () => 'x');
    await new EmpresaActivityInbound().execute({ headers: {}, args: [] } as never, next as never);
    expect(executar).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
