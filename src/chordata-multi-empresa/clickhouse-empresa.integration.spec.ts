import { ClickHouseService } from '../modules/processing/clickhouse/clickhouse.service';
import { ClickHouseEmpresa } from './clickhouse-empresa';

/**
 * Integração com ClickHouse REAL. Cria e APAGA bancos `evo_campaign_teste_*`; nunca toca no `evo_campaign`.
 * Só roda com CLICKHOUSE_TEST_HOST (+ CLICKHOUSE_USERNAME/CLICKHOUSE_PASSWORD), ex.: na rede do compose.
 */
const HOST = process.env.CLICKHOUSE_TEST_HOST;
const d = HOST ? describe : describe.skip;

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

jest.setTimeout(120_000);

d('Flow multi-empresa: ClickHouse por banco (ClickHouse real)', () => {
  let svc: ClickHouseService;
  let atual: string | undefined;

  beforeAll(async () => {
    Object.assign(process.env, {
      MULTI_EMPRESA: 'on',
      WRITE_MODE: 'ch-sync',
      QUEUE_MODE: 'direct',
      CLICKHOUSE_HOST: HOST,
    });
    ClickHouseEmpresa.reiniciarParaTestes();
    ClickHouseEmpresa.empresaAtual = () => atual;
    svc = new ClickHouseService();
    await svc.onModuleInit(); // multi-empresa: conecta e se registra, sem trocar o banco do cliente base
    await ClickHouseEmpresa.garantir(A, 'teste_a');
    await ClickHouseEmpresa.garantir(B, 'teste_b');
  }, 120_000);

  afterAll(async () => {
    atual = undefined;
    for (const banco of ['evo_campaign_teste_a', 'evo_campaign_teste_b']) {
      await svc.command({ query: `DROP DATABASE IF EXISTS ${banco}` }).catch(() => undefined);
    }
    await ClickHouseEmpresa.fechar();
    await svc.onModuleDestroy();
    ClickHouseEmpresa.reiniciarParaTestes();
  });

  const evento = (contato: string, nome: string) => ({
    contact_id: contato,
    event_type: 'track',
    event_name: nome,
    properties: '{}',
    traits: '{}',
    occurred_at: '2026-10-16 12:00:00.000',
    processing_time: '2026-10-16 12:00:00.000',
    message_raw: '{}',
    contact_or_anonymous_id: contato,
  });

  it('cada empresa grava e lê só no seu banco (consultas sem nome de banco)', async () => {
    atual = A;
    await svc.insert({ table: 'contact_events', values: [evento('c-a', 'comprou')] });
    atual = B;
    await svc.insert({ table: 'contact_events', values: [evento('c-b1', 'abriu'), evento('c-b2', 'abriu')] });

    atual = A;
    expect(Number((await svc.query<{ n: string }>({ query: 'SELECT count() AS n FROM contact_events' }))[0].n)).toBe(1);
    atual = B;
    expect(Number((await svc.query<{ n: string }>({ query: 'SELECT count() AS n FROM contact_events' }))[0].n)).toBe(2);
  });

  it('consultas com o prefixo fixo evo_campaign. são redirecionadas para o banco da empresa', async () => {
    atual = A;
    const r = await svc.query<{ n: string }>({ query: 'SELECT count() AS n FROM evo_campaign.contact_events' });
    expect(Number(r[0].n)).toBe(1); // o banco real evo_campaign tem outros eventos; aqui só vale o da empresa A
  });

  it('sem empresa o cliente base não enxerga tabela de evento nenhuma (falha segura)', async () => {
    atual = undefined;
    await expect(svc.query({ query: 'SELECT count() FROM contact_events' })).rejects.toBeDefined();
    expect(await svc.query({ query: 'SELECT 1 AS ok' })).toEqual([{ ok: 1 }]); // saúde continua funcionando
  });

  it('as tabelas de segmentos também foram criadas em cada banco', async () => {
    atual = A;
    const t = await svc.query<{ name: string }>({ query: 'SHOW TABLES' });
    expect(t.map(x => x.name)).toEqual(expect.arrayContaining(['contact_events', 'computed_property_state_v2', 'resolved_segment_state']));
  });
});
