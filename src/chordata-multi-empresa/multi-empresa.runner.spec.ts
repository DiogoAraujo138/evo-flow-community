import { DataSource } from 'typeorm';
import { EMPRESA_GUC } from './multi-empresa.constants';
import { EmpresaAusenteError, multiEmpresaRunner } from './multi-empresa.runner';

const EMPRESA = '11111111-1111-4111-8111-111111111111';

function fakeDataSource() {
  const manager = {
    query: jest.fn(async () => []),
  };
  const dataSource = {
    transaction: jest.fn(async (fn: (m: typeof manager) => Promise<unknown>) => fn(manager)),
  } as unknown as DataSource;
  return { dataSource, manager };
}

describe('multiEmpresaRunner', () => {
  it('aplica a empresa na transação ANTES de rodar o trabalho', async () => {
    const { dataSource, manager } = fakeDataSource();
    const ordem: string[] = [];
    manager.query.mockImplementation(async () => {
      ordem.push('set_config');
      return [];
    });

    const resultado = await multiEmpresaRunner(dataSource, EMPRESA, async m => {
      ordem.push('trabalho');
      expect(m).toBe(manager);
      return 42;
    });

    expect(resultado).toBe(42);
    expect(ordem).toEqual(['set_config', 'trabalho']);
    expect(manager.query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', [EMPRESA_GUC, EMPRESA]);
  });

  it.each([null, '', 'nao-e-uuid', "11111111-1111-4111-8111-11111111111'; DROP TABLE x;--"])(
    'recusa empresa inválida (%p) sem abrir transação',
    async valor => {
      const { dataSource } = fakeDataSource();
      const trabalho = jest.fn();

      await expect(multiEmpresaRunner(dataSource, valor as string | null, trabalho)).rejects.toBeInstanceOf(
        EmpresaAusenteError,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(trabalho).not.toHaveBeenCalled();
    },
  );

  it('propaga o erro do trabalho (a transação é desfeita pelo TypeORM)', async () => {
    const { dataSource } = fakeDataSource();

    await expect(
      multiEmpresaRunner(dataSource, EMPRESA, async () => {
        throw new Error('falhou');
      }),
    ).rejects.toThrow('falhou');
  });
});
