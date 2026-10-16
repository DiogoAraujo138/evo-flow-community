import { DataSource } from 'typeorm';
import { ClsServiceManager } from 'nestjs-cls';
import { TENANT_DB_MANAGER_CLS_KEY } from '../evo-extension-points/tenant-db-context/tenant-db-context.types';
import { usarTransacaoDaEmpresaNosRepositorios } from './temporal';

describe('repositórios da atividade vêm da transação da empresa', () => {
  const env = { ...process.env };
  beforeAll(() => {
    process.env.MULTI_EMPRESA = 'on';
    usarTransacaoDaEmpresaNosRepositorios();
    usarTransacaoDaEmpresaNosRepositorios(); // idempotente
  });
  afterAll(() => {
    process.env = { ...env };
  });

  const ds = () => new DataSource({ type: 'postgres' });

  it('com uma transação da empresa no contexto, o repositório vem dela', () => {
    const cls = ClsServiceManager.getClsService();
    const repositorio = { origem: 'transacao-da-empresa' };
    const manager = { getRepository: jest.fn(() => repositorio) };
    cls.run(() => {
      cls.set(TENANT_DB_MANAGER_CLS_KEY, manager);
      expect(ds().getRepository('Campaign')).toBe(repositorio);
    });
    expect(manager.getRepository).toHaveBeenCalledTimes(1);
    expect(manager.getRepository).toHaveBeenCalledWith('Campaign');
  });

  it('sem transação no contexto, segue o caminho original do TypeORM', () => {
    const repositorio = ds().getRepository('Campaign');
    expect(repositorio.constructor.name).toBe('Repository'); // o do TypeORM, não o de uma transação
  });
});
