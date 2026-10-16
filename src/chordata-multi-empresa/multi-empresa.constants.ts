/** Mesmo cabeçalho que o CRM e o frontend usam. */
export const EMPRESA_HEADER = 'x-evo-tenant-id';

/** Chave no CLS (AsyncLocalStorage) com a empresa da requisição atual. */
export const EMPRESA_CLS_KEY = 'empresaId';

/** Configuração do Postgres lida pelas políticas de RLS (por transação). */
export const EMPRESA_GUC = 'app.empresa_id';

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function multiEmpresaLigado(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MULTI_EMPRESA === 'on';
}
