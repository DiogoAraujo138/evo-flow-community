import { ForbiddenException } from '@nestjs/common';
import { EmpresaAcessoService } from './empresa-acesso.service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('EmpresaAcessoService', () => {
  const crm = { get: jest.fn() };
  const servico = new EmpresaAcessoService(crm as never);
  beforeEach(() => {
    crm.get.mockReset();
    servico.limparCache();
    delete process.env.EMPRESA_ACESSO_CACHE_MS;
  });

  it('aceita empresa que está na lista do usuário (consultada no CRM com o token dele)', async () => {
    crm.get.mockResolvedValue({ data: [{ id: A, ativa: true }] });

    await expect(servico.validarUsuario('tok', A)).resolves.toBeUndefined();
    expect(crm.get).toHaveBeenCalledWith('/api/v1/empresas', { authToken: 'tok' });
  });

  it('recusa empresa fora da lista', async () => {
    crm.get.mockResolvedValue({ data: [{ id: A, ativa: true }] });

    await expect(servico.validarUsuario('tok', B)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('recusa empresa desativada', async () => {
    crm.get.mockResolvedValue({ data: [{ id: A, ativa: false }] });

    await expect(servico.validarUsuario('tok', A)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('resposta vazia ou sem dados nunca libera', async () => {
    crm.get.mockResolvedValue(null);
    await expect(servico.validarUsuario('tok', A)).rejects.toBeInstanceOf(ForbiddenException);

    crm.get.mockResolvedValue({});
    await expect(servico.validarUsuario('tok', A)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('guarda a lista do usuário por um tempo: a 2ª requisição não chama o CRM', async () => {
    crm.get.mockResolvedValue({ data: [{ id: A, ativa: true }] });

    await servico.validarUsuario('tok-cache', A);
    await servico.validarUsuario('tok-cache', A);

    expect(crm.get).toHaveBeenCalledTimes(1);
  });

  it('acesso recém-concedido vale na hora: "não" visto no cache é conferido de novo no CRM', async () => {
    crm.get
      .mockResolvedValueOnce({ data: [{ id: A, ativa: true }] })
      .mockResolvedValueOnce({ data: [{ id: A, ativa: true }, { id: B, ativa: true }] });

    await servico.validarUsuario('tok-novo', A);
    await expect(servico.validarUsuario('tok-novo', B)).resolves.toBeUndefined();
    expect(crm.get).toHaveBeenCalledTimes(2);
  });

  it('o cache nunca mistura usuários: cada token tem a sua lista', async () => {
    crm.get.mockResolvedValueOnce({ data: [{ id: A, ativa: true }] }).mockResolvedValueOnce({ data: [{ id: B, ativa: true }] });

    await servico.validarUsuario('tok-do-a', A);
    await expect(servico.validarUsuario('tok-do-b', A)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('EMPRESA_ACESSO_CACHE_MS=0 desliga o cache', async () => {
    process.env.EMPRESA_ACESSO_CACHE_MS = '0';
    crm.get.mockResolvedValue({ data: [{ id: A, ativa: true }] });

    await servico.validarUsuario('tok-sem', A);
    await servico.validarUsuario('tok-sem', A);

    expect(crm.get).toHaveBeenCalledTimes(2);
  });

  it('empresaUnica: devolve o id só quando há exatamente uma empresa ativa', async () => {
    crm.get.mockResolvedValueOnce({ data: [{ id: A, ativa: true }, { id: B, ativa: false }] });
    await expect(servico.empresaUnica('tok-u1')).resolves.toBe(A);

    crm.get.mockResolvedValueOnce({ data: [{ id: A, ativa: true }, { id: B, ativa: true }] });
    await expect(servico.empresaUnica('tok-u2')).resolves.toBeNull();

    crm.get.mockResolvedValueOnce({ data: [] });
    await expect(servico.empresaUnica('tok-u3')).resolves.toBeNull();
  });
});
