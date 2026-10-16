import { Logger } from '@nestjs/common';
import { multiEmpresaLigado } from './multi-empresa.constants';

export interface EmpresaAtiva {
  id: string;
  slug: string;
}

interface ExecutorDeFundo {
  executarNaEmpresa<T>(empresaId: string | null | undefined, trabalho: () => Promise<T>): Promise<T>;
}

/** Ligado pelo MultiEmpresaModule no bootstrap (precisa do DataSource e do executor de fundo). */
export class ExecucaoPorEmpresa {
  static fundo: ExecutorDeFundo | null = null;
  static listar: (() => Promise<EmpresaAtiva[]>) | null = null;

  static configurar(fundo: ExecutorDeFundo | null, listar: (() => Promise<EmpresaAtiva[]>) | null): void {
    this.fundo = fundo;
    this.listar = listar;
  }
}

const logger = new Logger('PorEmpresa');

/**
 * Tarefa agendada (@Cron) não tem requisição nem dono: com multi-empresa ligado roda UMA VEZ POR EMPRESA ATIVA, cada
 * uma no seu contexto (banco, cache, ClickHouse). Uma empresa que falha não impede as outras; o primeiro erro é
 * relançado no fim. Desligado, é o método original.
 *
 * Use ABAIXO de @Cron: o @Cron guarda seus metadados na função que enxerga, e esta é a função já embrulhada.
 */
export function PorEmpresa(): MethodDecorator {
  return (_alvo, nome, descritor: PropertyDescriptor) => {
    const original = descritor.value as (...args: unknown[]) => Promise<unknown>;
    descritor.value = async function (this: unknown, ...args: unknown[]) {
      const { fundo, listar } = ExecucaoPorEmpresa;
      if (!multiEmpresaLigado() || !fundo || !listar) return original.apply(this, args);

      const empresas = await listar();
      let primeiroErro: unknown;
      for (const empresa of empresas) {
        try {
          await fundo.executarNaEmpresa(empresa.id, () => original.apply(this, args));
        } catch (erro) {
          logger.error(`${String(nome)} falhou na empresa ${empresa.slug}: ${(erro as Error)?.message}`);
          primeiroErro ??= erro;
        }
      }
      if (primeiroErro) throw primeiroErro;
    };
    return descritor;
  };
}
