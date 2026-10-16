import { EvoExtensionPoints } from '../evo-extension-points';
import { TENANT_DB_MANAGER_CLS_KEY } from '../evo-extension-points/tenant-db-context/tenant-db-context.types';
import { EMPRESA_CLS_KEY } from './multi-empresa.constants';
import { EmpresaDeFundoService } from './empresa-de-fundo.service';
import { EmpresaAusenteError, multiEmpresaRunner } from './multi-empresa.runner';

const A = '11111111-1111-4111-8111-111111111111';

function montar(resolvida: string | null = A) {
  const manager = { query: jest.fn().mockResolvedValue([]) };
  const dataSource = {
    transaction: jest.fn(async (fn: (m: typeof manager) => Promise<unknown>) => fn(manager)),
    query: jest.fn().mockResolvedValue([{ empresa: resolvida }]),
  };
  const guardado: Record<string, unknown> = {};
  const cls = {
    run: jest.fn(async (fn: () => Promise<unknown>) => fn()),
    set: (k: string, v: unknown) => (guardado[k] = v),
  };
  return { servico: new EmpresaDeFundoService(dataSource as never, cls as never), dataSource, manager, guardado };
}

describe('EmpresaDeFundoService', () => {
  const original = process.env.MULTI_EMPRESA;
  afterEach(() => {
    process.env.MULTI_EMPRESA = original;
  });

  describe('desligado (padrão)', () => {
    beforeEach(() => delete process.env.MULTI_EMPRESA);

    it('só executa o trabalho: nenhuma consulta, nenhuma transação', async () => {
      const { servico, dataSource } = montar();

      await expect(servico.executarParaCampanha('c1', async () => 'ok')).resolves.toBe('ok');
      await expect(servico.executarNaEmpresa(A, async () => 'ok2')).resolves.toBe('ok2');
      expect(dataSource.query).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('ligado', () => {
    beforeEach(() => {
      process.env.MULTI_EMPRESA = 'on';
      EvoExtensionPoints.replace('tenant_db_context', multiEmpresaRunner);
    });

    it('descobre a empresa pela campanha e roda o trabalho nela, com manager e empresa no CLS', async () => {
      const { servico, dataSource, manager, guardado } = montar();

      const r = await servico.executarParaCampanha('camp-1', async () => 'enviado');

      expect(r).toBe('enviado');
      expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining('chordata_resolver_empresa'), [
        'campaigns',
        'id',
        'camp-1',
      ]);
      expect(manager.query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', ['app.empresa_id', A]);
      expect(guardado[EMPRESA_CLS_KEY]).toBe(A);
      expect(guardado[TENANT_DB_MANAGER_CLS_KEY]).toBe(manager);
    });

    it('campanha que não existe: erro explícito e o trabalho NÃO roda', async () => {
      const { servico } = montar(null);
      const trabalho = jest.fn();

      await expect(servico.executarParaCampanha('fantasma', trabalho)).rejects.toBeInstanceOf(EmpresaAusenteError);
      expect(trabalho).not.toHaveBeenCalled();
    });

    it('empresa nula ou inválida: o trabalho NÃO roda', async () => {
      const { servico } = montar();
      const trabalho = jest.fn();

      await expect(servico.executarNaEmpresa(null, trabalho)).rejects.toBeInstanceOf(EmpresaAusenteError);
      await expect(servico.executarNaEmpresa('x', trabalho)).rejects.toBeInstanceOf(EmpresaAusenteError);
      expect(trabalho).not.toHaveBeenCalled();
    });
  });
});
