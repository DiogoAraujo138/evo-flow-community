import { ExecucaoPorEmpresa, PorEmpresa } from './por-empresa';

const empresas = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'a' },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', slug: 'b' },
];

class Servico {
  chamadas: string[] = [];
  falharEm: string | null = null;
  atual: string | null = null;

  @PorEmpresa()
  async tarefa(prefixo: string): Promise<void> {
    this.chamadas.push(`${prefixo}:${this.atual}`);
    if (this.falharEm && this.atual === this.falharEm) throw new Error('falhou');
  }
}

describe('@PorEmpresa', () => {
  const env = { ...process.env };
  let servico: Servico;

  beforeEach(() => {
    servico = new Servico();
    ExecucaoPorEmpresa.configurar(
      {
        executarNaEmpresa: async (id, trabalho) => {
          servico.atual = id ?? null;
          try {
            return await trabalho();
          } finally {
            servico.atual = null;
          }
        },
      },
      async () => empresas,
    );
  });
  afterEach(() => {
    process.env = { ...env };
    ExecucaoPorEmpresa.configurar(null, null);
  });

  it('desligado, roda o método original uma vez, sem empresa', async () => {
    delete process.env.MULTI_EMPRESA;
    await servico.tarefa('x');
    expect(servico.chamadas).toEqual(['x:null']);
  });

  it('ligado, roda uma vez por empresa ativa, com os argumentos e o this originais', async () => {
    process.env.MULTI_EMPRESA = 'on';
    await servico.tarefa('x');
    expect(servico.chamadas).toEqual([`x:${empresas[0].id}`, `x:${empresas[1].id}`]);
  });

  it('uma empresa que falha não impede as outras; o erro é relançado no fim', async () => {
    process.env.MULTI_EMPRESA = 'on';
    servico.falharEm = empresas[0].id;
    await expect(servico.tarefa('x')).rejects.toThrow('falhou');
    expect(servico.chamadas).toHaveLength(2);
  });

  it('ligado mas antes do bootstrap (sem executor), roda o original sem escopo (falha segura no banco)', async () => {
    process.env.MULTI_EMPRESA = 'on';
    ExecucaoPorEmpresa.configurar(null, null);
    await servico.tarefa('x');
    expect(servico.chamadas).toEqual(['x:null']);
  });
});
