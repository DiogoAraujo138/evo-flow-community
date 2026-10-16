/* eslint-disable no-console */
import 'dotenv/config';
import { AppDataSource } from '../database/ormconfig';
import { criarPapelAplicacao, instalarEsquema, removerEsquema } from './esquema';

/**
 * Uso (depois de `npm run build`):
 *   EMPRESA_PADRAO_ID=<uuid da empresa padrão do CRM> node dist/chordata-multi-empresa/cli.js instalar
 *   node dist/chordata-multi-empresa/cli.js remover
 *   PAPEL=evo_flow_app SENHA=... node dist/chordata-multi-empresa/cli.js papel
 * Imprime o banco alvo antes de agir.
 */
async function main(): Promise<void> {
  const comando = process.argv[2];
  await AppDataSource.initialize();
  const [{ db }] = await AppDataSource.query('select current_database() as db');
  console.log(`Banco: ${db}`);
  try {
    if (comando === 'instalar') {
      const id = process.env.EMPRESA_PADRAO_ID;
      if (!id) throw new Error('Informe EMPRESA_PADRAO_ID (uuid da empresa padrão do CRM)');
      await instalarEsquema(AppDataSource, id);
      console.log('Isolamento por empresa instalado.');
    } else if (comando === 'remover') {
      await removerEsquema(AppDataSource);
      console.log('Isolamento por empresa removido.');
    } else if (comando === 'papel') {
      await criarPapelAplicacao(AppDataSource, process.env.PAPEL ?? 'evo_flow_app', process.env.SENHA);
      console.log('Papel da aplicação pronto.');
    } else {
      throw new Error('Comando: instalar | remover | papel');
    }
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch(erro => {
  console.error(erro.message);
  process.exit(1);
});
