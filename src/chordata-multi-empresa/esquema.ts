import { DataSource, QueryRunner } from 'typeorm';

/**
 * Isolamento por empresa no banco do Flow (ADR-0007). Mesmo desenho do CRM: coluna `empresa_id`, DEFAULT que
 * carimba a empresa atual, RLS forçado e uma política única. Tudo em uma transação; idempotente.
 *
 * A empresa atual vem da configuração `app.empresa_id`, aplicada por transação (SET LOCAL) pelo runner
 * (`multi-empresa.runner.ts`). Sem empresa definida nenhuma linha é visível e nenhuma pode ser gravada.
 */
export const TABELAS_DE_EMPRESA = [
  'campaign_executions',
  'campaign_tracked_pages',
  'campaigns',
  'campaigns_configs',
  'campaigns_contacts',
  'campaigns_templates',
  'contacts',
  'custom_attribute_definitions',
  'custom_domains',
  'journey_sessions',
  'journeys',
  'labels',
  'link_parameters',
  'scheduled_journey_actions',
  'segments',
  'short_links',
  'taggings',
  'tags',
] as const;

/** Tabelas do TypeORM/infra: ficam fora do isolamento. */
export const TABELAS_GLOBAIS = ['migrations'] as const;

/**
 * Índices únicos de negócio que passam a ser únicos POR EMPRESA (empresa_id entra no índice).
 * Os demais continuam como estão: ou são ids uuid (já únicos por empresa) ou são chaves de resolução
 * pública (short_code, domain), que precisam seguir únicas no sistema todo.
 */
export const UNICOS_POR_EMPRESA: Record<string, string[]> = {
  campaigns: ['name'],
  contacts: ['email', 'identifier'],
  custom_attribute_definitions: ['attribute_key,attribute_model'],
  labels: ['title'],
  segments: ['name'],
  tags: ['name'],
};

/** Chaves que um acesso público (clique em link curto, domínio próprio) usa para achar a empresa. */
export const CHAVES_DE_RESOLUCAO: ReadonlyArray<[string, string]> = [
  ['short_links', 'short_code'],
  ['custom_domains', 'domain'],
  // consumidores de fila recebem só o id da campanha e precisam achar a empresa dela
  ['campaigns', 'id'],
];

export const PAPEL_RESOLVEDOR = 'chordata_resolvedor';
const ident = (nome: string) => `"${nome.replace(/"/g, '""')}"`;

export async function instalarEsquema(
  dataSource: DataSource,
  empresaPadraoId: string,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(empresaPadraoId)) {
    throw new Error('empresaPadraoId precisa ser um uuid');
  }
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await criarFuncoes(runner);
    for (const tabela of TABELAS_DE_EMPRESA) {
      await isolarTabela(runner, tabela, empresaPadraoId);
    }
    await converterUnicos(runner);
    await criarResolvedor(runner);
    await runner.commitTransaction();
  } catch (erro) {
    await runner.rollbackTransaction();
    throw erro;
  } finally {
    await runner.release();
  }
}

export async function removerEsquema(dataSource: DataSource): Promise<void> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await runner.query(
      'DROP FUNCTION IF EXISTS chordata_resolver_empresa(text, text, text)',
    );
    await runner.query('DROP TABLE IF EXISTS chordata_chaves_resolucao');
    await restaurarUnicos(runner);
    for (const tabela of TABELAS_DE_EMPRESA) {
      const t = ident(tabela);
      await runner.query(`DROP POLICY IF EXISTS isolamento_por_empresa ON ${t}`);
      await runner.query(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      await runner.query(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`);
      await runner.query(`ALTER TABLE ${t} DROP COLUMN IF EXISTS empresa_id CASCADE`);
    }
    await runner.query('DROP FUNCTION IF EXISTS chordata_empresa_atual()');
    await runner.commitTransaction();
  } catch (erro) {
    await runner.rollbackTransaction();
    throw erro;
  } finally {
    await runner.release();
  }
}

/** Devolve os índices únicos originais (tira empresa_id dos índices `*_empresa`) antes de apagar a coluna. */
async function restaurarUnicos(runner: QueryRunner): Promise<void> {
  const indices: Array<{ nome: string; definicao: string }> = await runner.query(`
    SELECT i.relname AS nome, pg_get_indexdef(ix.indexrelid) AS definicao
    FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
    WHERE ix.indisunique AND i.relname LIKE '%\_empresa'
  `);
  for (const { nome, definicao } of indices) {
    const original = nome.replace(/_empresa$/, '');
    const novo = definicao
      .replace('USING btree (empresa_id, ', 'USING btree (')
      .replace(/INDEX \S+ ON/, `INDEX ${ident(original)} ON`);
    await runner.query(`DROP INDEX IF EXISTS ${ident(nome)}`);
    await runner.query(novo);
  }
}

async function criarFuncoes(runner: QueryRunner): Promise<void> {
  await runner.query(`
    CREATE OR REPLACE FUNCTION chordata_empresa_atual() RETURNS uuid
      LANGUAGE sql STABLE
      AS $$ SELECT NULLIF(current_setting('app.empresa_id', true), '')::uuid $$
  `);
}

async function isolarTabela(
  runner: QueryRunner,
  tabela: string,
  empresaPadraoId: string,
): Promise<void> {
  const t = ident(tabela);
  await runner.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS empresa_id uuid`);
  await runner.query(
    `UPDATE ${t} SET empresa_id = '${empresaPadraoId}' WHERE empresa_id IS NULL`,
  );
  await runner.query(`ALTER TABLE ${t} ALTER COLUMN empresa_id SET NOT NULL`);
  await runner.query(
    `ALTER TABLE ${t} ALTER COLUMN empresa_id SET DEFAULT chordata_empresa_atual()`,
  );
  await runner.query(
    `CREATE INDEX IF NOT EXISTS ${ident(`idx_${tabela}_empresa_id`)} ON ${t} (empresa_id)`,
  );
  await runner.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
  await runner.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
  await runner.query(`DROP POLICY IF EXISTS isolamento_por_empresa ON ${t}`);
  await runner.query(`
    CREATE POLICY isolamento_por_empresa ON ${t}
      USING (empresa_id = chordata_empresa_atual())
      WITH CHECK (empresa_id = chordata_empresa_atual())
  `);
}

async function converterUnicos(runner: QueryRunner): Promise<void> {
  for (const [tabela, listas] of Object.entries(UNICOS_POR_EMPRESA)) {
    for (const colunas of listas) {
      const indices: Array<{ nome: string; definicao: string }> =
        await runner.query(
          `
        SELECT i.relname AS nome, pg_get_indexdef(ix.indexrelid) AS definicao
        FROM pg_index ix
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        WHERE t.relname = $1 AND ix.indisunique AND NOT ix.indisprimary
          AND i.relname NOT LIKE '%\\_empresa'
          AND (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                 FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) = $2
      `,
          [tabela, colunas],
        );
      for (const { nome, definicao } of indices) {
        const novo = definicao
          .replace('USING btree (', 'USING btree (empresa_id, ')
          .replace(/INDEX \S+ ON/, `INDEX ${ident(`${nome}_empresa`)} ON`);
        await runner.query(`DROP INDEX IF EXISTS ${ident(nome)}`);
        await runner.query(novo);
      }
    }
  }
}

async function criarResolvedor(runner: QueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS chordata_chaves_resolucao (
      tabela text NOT NULL, coluna text NOT NULL, PRIMARY KEY (tabela, coluna)
    )
  `);
  await runner.query('DELETE FROM chordata_chaves_resolucao');
  for (const [tabela, coluna] of CHAVES_DE_RESOLUCAO) {
    await runner.query('INSERT INTO chordata_chaves_resolucao VALUES ($1, $2)', [
      tabela,
      coluna,
    ]);
  }
  const existe = await runner.query(
    'SELECT 1 FROM pg_roles WHERE rolname = $1',
    [PAPEL_RESOLVEDOR],
  );
  if (existe.length === 0) {
    await runner.query(
      `CREATE ROLE ${PAPEL_RESOLVEDOR} NOLOGIN NOSUPERUSER BYPASSRLS`,
    );
  }
  await runner.query(`
    CREATE OR REPLACE FUNCTION chordata_resolver_empresa(p_tabela text, p_coluna text, p_valor text)
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
    DECLARE resultado uuid;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM chordata_chaves_resolucao WHERE tabela = p_tabela AND coluna = p_coluna) THEN
        RAISE EXCEPTION 'chave de resolucao nao permitida: %.%', p_tabela, p_coluna;
      END IF;
      EXECUTE format('SELECT empresa_id FROM %I WHERE %I::text = $1 LIMIT 1', p_tabela, p_coluna)
        INTO resultado USING p_valor;
      RETURN resultado;
    END
    $fn$
  `);
  await runner.query(
    'REVOKE ALL ON FUNCTION chordata_resolver_empresa(text, text, text) FROM PUBLIC',
  );
  await runner.query(
    `ALTER FUNCTION chordata_resolver_empresa(text, text, text) OWNER TO ${PAPEL_RESOLVEDOR}`,
  );
  await runner.query(
    `GRANT SELECT ON chordata_chaves_resolucao TO ${PAPEL_RESOLVEDOR}`,
  );
  for (const [tabela, coluna] of CHAVES_DE_RESOLUCAO) {
    await runner.query(
      `GRANT SELECT (empresa_id, ${ident(coluna)}) ON ${ident(tabela)} TO ${PAPEL_RESOLVEDOR}`,
    );
  }
}

/** Papel comum para a aplicação (sem superusuário, sem bypass de RLS). */
export async function criarPapelAplicacao(
  dataSource: DataSource,
  nome: string,
  senha?: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(nome)) throw new Error('nome de papel inválido');
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    const existe = await runner.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [nome],
    );
    if (existe.length === 0) {
      const login = senha ? `LOGIN PASSWORD '${senha.replace(/'/g, "''")}'` : 'NOLOGIN';
      await runner.query(`CREATE ROLE ${nome} ${login} NOSUPERUSER NOBYPASSRLS`);
    }
    await runner.query(`GRANT USAGE ON SCHEMA public TO ${nome}`);
    await runner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${nome}`,
    );
    await runner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${nome}`);
    await runner.query(
      `GRANT EXECUTE ON FUNCTION chordata_resolver_empresa(text, text, text) TO ${nome}`,
    );
  } finally {
    await runner.release();
  }
}
