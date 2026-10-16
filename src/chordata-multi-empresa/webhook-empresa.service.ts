import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { multiEmpresaLigado } from './multi-empresa.constants';

/** Prefixo do caminho que diz de quem é o webhook: `/webhooks/empresa/<slug>/<plataforma>`. */
export const PREFIXO_WEBHOOK_EMPRESA = 'empresa';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class WebhookSemEmpresaError extends Error {
  constructor(motivo: 'ausente' | 'desconhecida') {
    super(`webhook sem empresa válida (${motivo})`);
    this.name = 'WebhookSemEmpresaError';
  }
}

export interface WebhookResolvido {
  /** Caminho sem o prefixo da empresa (o que o detector de plataforma espera). */
  caminho: string;
  empresaId?: string;
}

/**
 * Webhook público não tem usuário nem cabeçalho de empresa (o provedor só chama uma URL). Com multi-empresa ligado
 * a empresa vem do caminho: `/webhooks/empresa/<slug>/<plataforma>`. Sem prefixo, ou com empresa desconhecida/
 * inativa, o webhook é recusado: nunca cai numa empresa por padrão. Desligado, devolve o caminho como veio.
 *
 * Limite conhecido: o segredo de assinatura de cada provedor é global, então a assinatura prova que veio do
 * provedor, não de qual empresa; o slug na URL é quem escolhe a empresa.
 */
@Injectable()
export class WebhookEmpresaService {
  constructor(private readonly dataSource: DataSource) {}

  async resolver(caminho: string): Promise<WebhookResolvido> {
    if (!multiEmpresaLigado()) return { caminho };
    const partes = caminho.split('/');
    if (partes[0]?.toLowerCase() !== PREFIXO_WEBHOOK_EMPRESA || !partes[1]) {
      throw new WebhookSemEmpresaError('ausente');
    }
    const slug = partes[1].toLowerCase();
    if (!SLUG_RE.test(slug)) throw new WebhookSemEmpresaError('desconhecida');
    const linhas: Array<{ id: string }> = await this.dataSource.query(
      'SELECT id FROM empresas WHERE slug = $1 AND ativa',
      [slug],
    );
    if (!linhas[0]) throw new WebhookSemEmpresaError('desconhecida');
    return { caminho: partes.slice(2).join('/'), empresaId: linhas[0].id };
  }
}
