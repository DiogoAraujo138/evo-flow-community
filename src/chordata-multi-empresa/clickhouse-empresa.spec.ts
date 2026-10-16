import { ClickHouseEmpresa, nomeDoBanco } from './clickhouse-empresa';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function servicoFalso() {
  const clientes: Record<string, { banco: string; close: jest.Mock }> = {};
  return {
    clientes,
    prepararBanco: jest.fn().mockResolvedValue(undefined),
    criarClienteParaBanco: jest.fn((banco: string) => (clientes[banco] = { banco, close: jest.fn().mockResolvedValue(undefined) })),
  };
}

describe('ClickHouse por empresa', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.MULTI_EMPRESA = 'on';
    delete process.env.CLICKHOUSE_DATABASE;
    ClickHouseEmpresa.reiniciarParaTestes();
  });
  afterEach(() => {
    process.env = { ...env };
    ClickHouseEmpresa.reiniciarParaTestes();
  });

  describe('nomeDoBanco', () => {
    it('a empresa padrão mantém o banco que já existe; as outras ganham o seu', () => {
      expect(nomeDoBanco('padrao')).toBe('evo_campaign');
      expect(nomeDoBanco('jurídico-pet')).toBe('evo_campaign_jur_dico_pet');
      expect(nomeDoBanco('VetConnection')).toBe('evo_campaign_vetconnection');
      expect(nomeDoBanco('mentall.vet')).toBe('evo_campaign_mentall_vet');
    });
    it('slug que não vira nome é recusado (nada de injeção no CREATE DATABASE)', () => {
      expect(() => nomeDoBanco('---')).toThrow();
      expect(nomeDoBanco("a'; DROP DATABASE x; --")).toBe('evo_campaign_a_drop_database_x');
    });
  });

  it('só aceita os modos que carregam a empresa', () => {
    expect(() => ClickHouseEmpresa.exigirModosCompativeis({ WRITE_MODE: 'ch-sync', QUEUE_MODE: 'direct' })).not.toThrow();
    expect(() => ClickHouseEmpresa.exigirModosCompativeis({ WRITE_MODE: 'kafka', QUEUE_MODE: 'direct' })).toThrow(/ch-sync/);
    expect(() => ClickHouseEmpresa.exigirModosCompativeis({})).toThrow();
  });

  it('prepara o banco uma vez só, mesmo com chamadas simultâneas', async () => {
    const s = servicoFalso();
    ClickHouseEmpresa.configurar(s as never);
    await Promise.all([ClickHouseEmpresa.garantir(A, 'a'), ClickHouseEmpresa.garantir(A, 'a'), ClickHouseEmpresa.garantir(A, 'a')]);
    await ClickHouseEmpresa.garantir(A, 'a');
    expect(s.prepararBanco).toHaveBeenCalledTimes(1);
    expect(s.prepararBanco).toHaveBeenCalledWith('evo_campaign_a');
  });

  it('descobre o slug pela busca quando não foi informado e recusa empresa sem slug', async () => {
    const s = servicoFalso();
    ClickHouseEmpresa.configurar(s as never);
    ClickHouseEmpresa.definirBuscaDeSlug(async id => (id === A ? 'loja' : null));
    await ClickHouseEmpresa.garantir(A);
    expect(s.prepararBanco).toHaveBeenCalledWith('evo_campaign_loja');
    await expect(ClickHouseEmpresa.garantir(B)).rejects.toThrow(/sem slug/);
  });

  it('escolhe cliente e banco pela empresa corrente', async () => {
    const s = servicoFalso();
    ClickHouseEmpresa.configurar(s as never);
    await ClickHouseEmpresa.garantir(A, 'a');
    await ClickHouseEmpresa.garantir(B, 'padrao');

    ClickHouseEmpresa.empresaAtual = () => A;
    expect(ClickHouseEmpresa.bancoAtual()).toBe('evo_campaign_a');
    expect((ClickHouseEmpresa.clienteAtual() as unknown as { banco: string }).banco).toBe('evo_campaign_a');
    ClickHouseEmpresa.empresaAtual = () => B;
    expect(ClickHouseEmpresa.bancoAtual()).toBe('evo_campaign');

    ClickHouseEmpresa.empresaAtual = () => undefined; // sem empresa: cliente base (sem dados)
    expect(ClickHouseEmpresa.clienteAtual()).toBeNull();
    expect(ClickHouseEmpresa.bancoAtual()).toBeNull();
  });

  it('empresa com banco não preparado nunca cai no banco de outra', () => {
    ClickHouseEmpresa.configurar(servicoFalso() as never);
    ClickHouseEmpresa.empresaAtual = () => A;
    expect(() => ClickHouseEmpresa.clienteAtual()).toThrow(/não está preparado/);
  });

  it('reescreve evo_campaign.<tabela> para o banco da empresa, sem tocar em outros nomes', async () => {
    ClickHouseEmpresa.configurar(servicoFalso() as never);
    await ClickHouseEmpresa.garantir(A, 'a');
    ClickHouseEmpresa.empresaAtual = () => A;
    const sql =
      "INSERT INTO evo_campaign.computed_property_state_v2 SELECT 1 FROM evo_campaign.contact_events WHERE x = 'evo_campaign_total' AND y = evo_campaign_x.t";
    expect(ClickHouseEmpresa.reescrever(sql)).toBe(
      "INSERT INTO evo_campaign_a.computed_property_state_v2 SELECT 1 FROM evo_campaign_a.contact_events WHERE x = 'evo_campaign_total' AND y = evo_campaign_x.t",
    );
    ClickHouseEmpresa.empresaAtual = () => undefined;
    expect(ClickHouseEmpresa.reescrever(sql)).toBe(sql);
  });

  it('durante o preparo não escolhe cliente nem reescreve (o DDL fala do banco alvo)', async () => {
    ClickHouseEmpresa.configurar(servicoFalso() as never);
    await ClickHouseEmpresa.garantir(A, 'a');
    ClickHouseEmpresa.empresaAtual = () => A;
    await ClickHouseEmpresa.semEscolhaPorEmpresa(async () => {
      expect(ClickHouseEmpresa.clienteAtual()).toBeNull();
      expect(ClickHouseEmpresa.reescrever('SELECT evo_campaign.x')).toBe('SELECT evo_campaign.x');
    });
    expect(ClickHouseEmpresa.bancoAtual()).toBe('evo_campaign_a');
  });

  it('desligado, nada muda', async () => {
    delete process.env.MULTI_EMPRESA;
    ClickHouseEmpresa.empresaAtual = () => A;
    expect(ClickHouseEmpresa.clienteAtual()).toBeNull();
    expect(ClickHouseEmpresa.reescrever('SELECT evo_campaign.x')).toBe('SELECT evo_campaign.x');
    await expect(ClickHouseEmpresa.garantir(A, 'a')).resolves.toBeUndefined();
  });
});
