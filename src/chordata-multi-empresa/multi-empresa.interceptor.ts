import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { DataSource } from 'typeorm';
import { Observable, from, lastValueFrom } from 'rxjs';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { EvoExtensionPoints } from '../evo-extension-points';
import { TENANT_DB_MANAGER_CLS_KEY } from '../evo-extension-points/tenant-db-context/tenant-db-context.types';
import { ClickHouseEmpresa } from './clickhouse-empresa';
import { EmpresaAcessoService } from './empresa-acesso.service';
import {
  EMPRESA_CLS_KEY,
  EMPRESA_HEADER,
  UUID_RE,
} from './multi-empresa.constants';

/**
 * Abre, para cada requisição HTTP, a transação com a empresa aplicada e publica o manager no CLS
 * (é de onde o TenantDbContext tira o repositório). Rotas públicas (saúde, métricas, webhooks, ingestão de
 * eventos) seguem sem empresa e, por isso, sem acesso às tabelas isoladas; o redirecionamento de link curto
 * descobre a empresa pelo código (função chordata_resolver_empresa).
 */
@Injectable()
export class MultiEmpresaInterceptor implements NestInterceptor {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cls: ClsService,
    private readonly reflector: Reflector,
    private readonly acesso: EmpresaAcessoService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest();
    const publica = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    let empresaId: string | null = null;
    if (publica) {
      empresaId = await this.empresaDoLinkCurto(req);
      if (!empresaId) return next.handle(); // pública sem empresa: segue sem acesso às tabelas isoladas
    } else {
      empresaId = await this.empresaDaRequisicao(req);
    }

    if (empresaId) await ClickHouseEmpresa.garantir(empresaId); // empresa nova: prepara o banco de eventos
    const runner = EvoExtensionPoints.get('tenant_db_context');
    return from(
      runner(this.dataSource, empresaId, async manager => {
        this.cls.set(TENANT_DB_MANAGER_CLS_KEY, manager);
        this.cls.set(EMPRESA_CLS_KEY, empresaId);
        return lastValueFrom(next.handle(), { defaultValue: undefined });
      }),
    );
  }

  private async empresaDaRequisicao(req: {
    headers: Record<string, string | string[] | undefined>;
  }): Promise<string> {
    const bruto = req.headers[EMPRESA_HEADER];
    const empresaId = (Array.isArray(bruto) ? bruto[0] : bruto)?.trim();
    if (!empresaId) {
      throw new BadRequestException('Informe a empresa no cabeçalho X-Evo-Tenant-Id');
    }
    if (!UUID_RE.test(empresaId)) {
      throw new BadRequestException('Empresa inválida');
    }
    const chaveDeServico = req.headers['x-integration-api-key'];
    if (!chaveDeServico) {
      const autorizacao = req.headers.authorization;
      const token =
        typeof autorizacao === 'string' && autorizacao.startsWith('Bearer ')
          ? autorizacao.slice('Bearer '.length).trim()
          : undefined;
      if (!token) {
        // sem Bearer (ex.: api_access_token): não há como conferir vínculo; recusa em vez de confiar
        throw new BadRequestException('Credencial sem vínculo de empresa verificável');
      }
      await this.acesso.validarUsuario(token, empresaId);
    }
    return empresaId;
  }

  /** /link/:shortCode é público: a empresa vem do próprio link. */
  private async empresaDoLinkCurto(req: {
    path?: string;
    originalUrl?: string;
  }): Promise<string | null> {
    const caminho = (req.path ?? req.originalUrl ?? '').split('?')[0];
    const m = /^\/link\/([^/]+)$/.exec(caminho);
    if (!m) return null;
    const linhas: Array<{ empresa: string | null }> = await this.dataSource.query(
      'SELECT chordata_resolver_empresa($1, $2, $3) AS empresa',
      ['short_links', 'short_code', m[1]],
    );
    return linhas[0]?.empresa ?? null;
  }
}
