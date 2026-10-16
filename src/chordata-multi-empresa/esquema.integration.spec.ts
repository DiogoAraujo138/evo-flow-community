import { DataSource, QueryRunner } from 'typeorm';
import {
  CHAVES_DE_RESOLUCAO,
  TABELAS_DE_EMPRESA,
  TABELAS_GLOBAIS,
  criarPapelAplicacao,
  instalarEsquema,
  removerEsquema,
} from './esquema';

/**
 * Integração com Postgres REAL, numa CÓPIA do banco do Flow (nunca no banco de uso).
 * Só roda com FLOW_MT_PG_URL apontando para um banco descartável, ex.:
 *   FLOW_MT_PG_URL=postgres://postgres:***@localhost:55434/evo_campaign_clone
 */
const URL = process.env.FLOW_MT_PG_URL;
const d = URL ? describe : describe.skip;

const PADRAO = '00000000-0000-4000-8000-000000000001';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAPEL = 'evo_flow_teste_app';

d('Flow multi-empresa: esquema e RLS (Postgres real)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', url: URL });
    await ds.initialize();
    const alvo = (await ds.query('select current_database() as db'))[0].db as string;
    if (!/clone|teste|test|tmp/i.test(alvo)) {
      throw new Error(`recusado: ${alvo} não parece um banco descartável`);
    }
    await removerEsquema(ds); // começa limpo e prova que remover funciona
    await instalarEsquema(ds, PADRAO);
    await criarPapelAplicacao(ds, PAPEL);
  }, 60_000);

  afterAll(async () => {
    await ds?.destroy();
  });

  async function dentroDeTransacao<T>(fn: (r: QueryRunner) => Promise<T>): Promise<T> {
    const r = ds.createQueryRunner();
    await r.connect();
    await r.startTransaction();
    try {
      return await fn(r);
    } finally {
      await r.rollbackTransaction();
      await r.release();
    }
  }

  const neutro = (tipo: string, udt: string): string => {
    if (tipo === 'uuid') return 'gen_random_uuid()';
    if (['integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real'].includes(tipo)) return '0';
    if (tipo === 'boolean') return 'false';
    if (tipo === 'json' || tipo === 'jsonb') return "'{}'";
    if (/timestamp|date|time/.test(tipo)) return 'now()';
    if (tipo === 'ARRAY') return "'{}'";
    if (tipo === 'USER-DEFINED') return `(SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = '${udt}' ORDER BY e.enumsortorder LIMIT 1)`;
    return `'${Math.random().toString(16).slice(2, 4)}'`;
  };

  async function semear(r: QueryRunner, tabela: string, empresa: string): Promise<void> {
    const cols: Array<{ column_name: string; data_type: string; udt_name: string }> = await r.query(
      `SELECT column_name, data_type, udt_name FROM information_schema.columns
       WHERE table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL AND column_name <> 'empresa_id'`,
      [tabela],
    );
    const nomes = ['empresa_id', ...cols.map(c => `"${c.column_name}"`)];
    const valores = [`'${empresa}'`, ...cols.map(c => neutro(c.data_type, c.udt_name))];
    await r.query(`INSERT INTO "${tabela}" (${nomes.join(', ')}) VALUES (${valores.join(', ')})`);
  }

  it('toda tabela de empresa tem coluna NOT NULL, default de carimbo, RLS forçado e política', async () => {
    const problemas: string[] = [];
    for (const t of TABELAS_DE_EMPRESA) {
      const [rel] = await ds.query('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', [t]);
      const [col] = await ds.query(
        `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND column_name = 'empresa_id'`,
        [t],
      );
      const pol = await ds.query(`SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = 'isolamento_por_empresa'`, [t]);
      if (!rel?.relrowsecurity || !rel?.relforcerowsecurity) problemas.push(`${t}: RLS desligado`);
      if (col?.is_nullable !== 'NO') problemas.push(`${t}: empresa_id aceita nulo`);
      if (!String(col?.column_default).includes('chordata_empresa_atual')) problemas.push(`${t}: sem default de carimbo`);
      if (pol.length !== 1) problemas.push(`${t}: sem política`);
    }
    expect(problemas).toEqual([]);
  });

  it('toda tabela do banco está classificada (guarda contra tabela nova do upstream)', async () => {
    const reais: Array<{ table_name: string }> = await ds.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const conhecidas = new Set<string>([...TABELAS_DE_EMPRESA, ...TABELAS_GLOBAIS, 'chordata_chaves_resolucao']);
    const sobra = reais.map(r => r.table_name).filter(t => !conhecidas.has(t));

    expect(sobra).toEqual([]);
  });

  it('o dado que já existia foi para a empresa padrão', async () => {
    const [{ total }] = await ds.query(`SELECT count(*)::int AS total FROM campaigns WHERE empresa_id <> $1`, [PADRAO]);
    expect(total).toBe(0);
  });

  it('cada empresa enxerga só as próprias linhas em TODAS as tabelas; sem empresa não enxerga nada', async () => {
    const falhas: string[] = [];
    const semSemente: string[] = [];

    for (const tabela of TABELAS_DE_EMPRESA) {
      await dentroDeTransacao(async r => {
        try {
          await r.query(`SET LOCAL session_replication_role = replica`);
          await semear(r, tabela, A);
          await semear(r, tabela, B);
          await r.query(`SET LOCAL session_replication_role = origin`);
        } catch (e) {
          semSemente.push(`${tabela}: ${(e as Error).message.slice(0, 70)}`);
          return;
        }
        await r.query(`SET LOCAL ROLE ${PAPEL}`);
        await r.query(`SELECT set_config('app.empresa_id', $1, true)`, [A]);
        const vistas: Array<{ empresa_id: string }> = await r.query(`SELECT empresa_id FROM "${tabela}"`);
        const unicas = [...new Set(vistas.map(v => v.empresa_id))];
        if (unicas.length !== 1 || unicas[0] !== A) falhas.push(`${tabela}: A vê ${JSON.stringify(unicas)}`);
        await r.query(`SELECT set_config('app.empresa_id', '', true)`);
        const [{ total }] = await r.query(`SELECT count(*)::int AS total FROM "${tabela}"`);
        if (total !== 0) falhas.push(`${tabela}: sem empresa vê ${total}`);
      });
    }

    expect(falhas).toEqual([]);
    expect(semSemente).toEqual([]);
  }, 120_000);

  it('o banco carimba a empresa e recusa gravar em outra', async () => {
    await dentroDeTransacao(async r => {
      await r.query(`SET LOCAL ROLE ${PAPEL}`);
      await r.query(`SELECT set_config('app.empresa_id', $1, true)`, [A]);
      await r.query(`INSERT INTO labels (id, title) VALUES (gen_random_uuid(), 'carimbada')`);
      const [{ empresa_id }] = await r.query(`SELECT empresa_id FROM labels WHERE title = 'carimbada'`);
      expect(empresa_id).toBe(A);
      await r.query('SAVEPOINT s');
      await expect(
        r.query(`INSERT INTO labels (id, title, empresa_id) VALUES (gen_random_uuid(), 'intrusa', $1)`, [B]),
      ).rejects.toThrow(/row-level security/);
      await r.query('ROLLBACK TO SAVEPOINT s');
    });
  });

  it('o mesmo nome de campanha pode existir em duas empresas, mas não duas vezes na mesma', async () => {
    await dentroDeTransacao(async r => {
      await r.query(`SET LOCAL session_replication_role = replica`);
      await semear(r, 'campaigns', A);
      await r.query(`UPDATE campaigns SET name = 'mesmo' WHERE empresa_id = $1`, [A]);
      await semear(r, 'campaigns', B);
      await r.query(`UPDATE campaigns SET name = 'mesmo' WHERE empresa_id = $1`, [B]);
      await r.query('SAVEPOINT dup');
      await expect(semear(r, 'campaigns', A).then(() => r.query(`UPDATE campaigns SET name = 'mesmo' WHERE empresa_id = $1`, [A]))).rejects.toThrow(/unique|duplicate/i);
      await r.query('ROLLBACK TO SAVEPOINT dup');
    });
  });

  it('resolve a empresa de um link curto sem escopo e recusa chaves fora da lista', async () => {
    await dentroDeTransacao(async r => {
      await r.query(`SET LOCAL session_replication_role = replica`);
      await semear(r, 'short_links', A);
      await r.query(`UPDATE short_links SET short_code = 'abc999' WHERE empresa_id = $1`, [A]);
      await r.query(`SET LOCAL ROLE ${PAPEL}`);
      const [ok] = await r.query(`SELECT chordata_resolver_empresa('short_links', 'short_code', 'abc999') AS e`);
      expect(ok.e).toBe(A);
      const [vazio] = await r.query(`SELECT chordata_resolver_empresa('short_links', 'short_code', 'nao-existe') AS e`);
      expect(vazio.e).toBeNull();
      const [{ total }] = await r.query(`SELECT count(*)::int AS total FROM short_links`);
      expect(total).toBe(0); // o papel da aplicação continua sem ler a tabela
      await r.query('SAVEPOINT s');
      await expect(r.query(`SELECT chordata_resolver_empresa('campaigns', 'name', 'x')`)).rejects.toThrow(/nao permitida/);
      await r.query('ROLLBACK TO SAVEPOINT s');
    });
    expect(CHAVES_DE_RESOLUCAO.length).toBeGreaterThanOrEqual(2);
  });

  it('instalar de novo é idempotente', async () => {
    await expect(instalarEsquema(ds, PADRAO)).resolves.toBeUndefined();
    const pol = await ds.query(`SELECT 1 FROM pg_policies WHERE tablename = 'campaigns'`);
    expect(pol).toHaveLength(1);
  }, 60_000);

  it('remover devolve os índices únicos originais e instalar de novo volta ao isolamento', async () => {
    const unicoPorNome = () =>
      ds.query(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'campaigns' AND indexdef LIKE 'CREATE UNIQUE%' AND indexdef LIKE '%(name)%'`,
      );
    await removerEsquema(ds);
    const colunas = await ds.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'campaigns' AND column_name = 'empresa_id'`,
    );
    expect(colunas).toHaveLength(0);
    expect(await unicoPorNome()).toHaveLength(1); // a unicidade original voltou

    await instalarEsquema(ds, PADRAO);
    const composto = await ds.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'campaigns' AND indexdef LIKE '%(empresa_id, name)%'`,
    );
    expect(composto).toHaveLength(1);
  }, 120_000);
});
