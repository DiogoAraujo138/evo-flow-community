import { Pool } from 'pg';
import type { DataSource } from 'typeorm';

/**
 * A tabela `empresas` mora no banco do CRM (fonte da verdade), não no do Flow. O Flow só precisa LER id/slug/ativa
 * (para preparar o banco de eventos de cada empresa, rodar tarefas por empresa e achar a empresa de um webhook).
 *
 * Com `MULTI_EMPRESA_CRM_DATABASE_URL` abre uma conexão própria, que deve usar um papel só com SELECT em `empresas`.
 * Sem a variável usa o banco do Flow (serve quando as tabelas estão juntas, como nos testes de integração).
 */
export class FonteDeEmpresas {
  private static pool: Pool | null = null;
  private static dataSource: Pick<DataSource, 'query'> | null = null;

  static configurar(dataSource: Pick<DataSource, 'query'> | null): void {
    this.dataSource = dataSource;
  }

  static async consultar<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const url = process.env.MULTI_EMPRESA_CRM_DATABASE_URL;
    if (url) {
      this.pool ??= new Pool({ connectionString: url, max: 3 });
      const resultado = await this.pool.query(sql, params);
      return resultado.rows as T[];
    }
    if (!this.dataSource) throw new Error('FonteDeEmpresas sem banco configurado');
    return (await this.dataSource.query(sql, params)) as T[];
  }

  static async fechar(): Promise<void> {
    await this.pool?.end().catch(() => undefined);
    this.pool = null;
  }

  static reiniciarParaTestes(): void {
    this.dataSource = null;
    void this.fechar();
  }
}
