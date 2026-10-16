import { ForbiddenException } from '@nestjs/common';
import { EmpresaAcessoService } from './empresa-acesso.service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('EmpresaAcessoService', () => {
  const crm = { get: jest.fn() };
  const servico = new EmpresaAcessoService(crm as never);
  beforeEach(() => crm.get.mockReset());

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
});
