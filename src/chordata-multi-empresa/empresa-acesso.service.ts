import { ForbiddenException, Injectable } from '@nestjs/common';
import { CrmClientService } from '../shared/crm-client/crm-client.service';

interface EmpresaDoCrm {
  id: string;
  ativa: boolean;
}

/**
 * Confere se o usuário pode usar a empresa pedida no cabeçalho. A fonte da verdade é o CRM
 * (GET /api/v1/empresas com o token do próprio usuário: a lista já vem filtrada por vínculo, e o
 * super_admin vê todas). Chamada de serviço (chave de integração) é confiável e não passa por aqui.
 */
@Injectable()
export class EmpresaAcessoService {
  constructor(private readonly crm: CrmClientService) {}

  async validarUsuario(bearerToken: string, empresaId: string): Promise<void> {
    const resposta = await this.crm.get<{ data?: EmpresaDoCrm[] }>(
      '/api/v1/empresas',
      { authToken: bearerToken },
    );
    const lista = resposta?.data ?? [];
    const permitida = lista.some(e => e.id === empresaId && e.ativa);
    if (!permitida) {
      throw new ForbiddenException('Sem acesso a esta empresa');
    }
  }
}
