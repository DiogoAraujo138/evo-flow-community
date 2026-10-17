import { createHash } from 'node:crypto';
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
 *
 * A lista de empresas do usuário fica em memória por poucos segundos (EMPRESA_ACESSO_CACHE_MS, padrão 30 s; 0 desliga):
 * antes cada requisição ao Flow fazia uma chamada ao CRM e, sob carga, era isso que abria o circuit breaker. Só a resposta
 * COM empresas é guardada (um acesso recém-concedido vale na hora) e um "não" visto com lista em cache é conferido de novo
 * no CRM antes de recusar. Revogação demora, no máximo, o tempo do cache (mesma ordem do cache de permissões do CRM).
 */
@Injectable()
export class EmpresaAcessoService {
  private readonly cache = new Map<string, { expira: number; empresas: EmpresaDoCrm[] }>();
  private static readonly MAXIMO = 2000;

  constructor(private readonly crm: CrmClientService) {}

  limparCache(): void {
    this.cache.clear();
  }

  private ttlMs(): number {
    const n = Number(process.env.EMPRESA_ACESSO_CACHE_MS ?? 30000);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  private async empresasDoUsuario(token: string, ignorarCache = false): Promise<{ lista: EmpresaDoCrm[]; doCache: boolean }> {
    const chave = createHash('sha256').update(token).digest('hex');
    const ttl = this.ttlMs();
    if (ttl > 0 && !ignorarCache) {
      const achado = this.cache.get(chave);
      if (achado && achado.expira > Date.now()) return { lista: achado.empresas, doCache: true };
    }
    const resposta = await this.crm.get<{ data?: EmpresaDoCrm[] }>('/api/v1/empresas', { authToken: token });
    const lista = resposta?.data ?? [];
    if (ttl > 0 && lista.length > 0) {
      if (this.cache.size >= EmpresaAcessoService.MAXIMO) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(chave, { expira: Date.now() + ttl, empresas: lista });
    }
    return { lista, doCache: false };
  }

  async validarUsuario(bearerToken: string, empresaId: string): Promise<void> {
    let { lista, doCache } = await this.empresasDoUsuario(bearerToken);
    let permitida = lista.some(e => e.id === empresaId && e.ativa);
    if (!permitida && doCache) {
      ({ lista } = await this.empresasDoUsuario(bearerToken, true));
      permitida = lista.some(e => e.id === empresaId && e.ativa);
    }
    if (!permitida) {
      throw new ForbiddenException('Sem acesso a esta empresa');
    }
  }

  /** Usuário com UMA só empresa ativa dispensa o cabeçalho (como o CRM e o Core); com várias é preciso escolher. */
  async empresaUnica(bearerToken: string): Promise<string | null> {
    const { lista } = await this.empresasDoUsuario(bearerToken);
    const ativas = lista.filter(e => e.ativa);
    return ativas.length === 1 ? ativas[0].id : null;
  }
}
