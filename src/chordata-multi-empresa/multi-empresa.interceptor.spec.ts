import { BadRequestException, CallHandler, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { EvoExtensionPoints } from '../evo-extension-points';
import { TENANT_DB_MANAGER_CLS_KEY } from '../evo-extension-points/tenant-db-context/tenant-db-context.types';
import { EMPRESA_CLS_KEY } from './multi-empresa.constants';
import { MultiEmpresaInterceptor } from './multi-empresa.interceptor';
import { multiEmpresaRunner } from './multi-empresa.runner';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function montar(opcoes: { publica?: boolean; resolvida?: string | null } = {}) {
  const manager = { query: jest.fn().mockResolvedValue([]) };
  const dataSource = {
    transaction: jest.fn(async (fn: (m: typeof manager) => Promise<unknown>) => fn(manager)),
    query: jest.fn().mockResolvedValue([{ empresa: opcoes.resolvida ?? null }]),
  };
  const armazenado: Record<string, unknown> = {};
  const cls = { set: (k: string, v: unknown) => (armazenado[k] = v) };
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(!!opcoes.publica) } as unknown as Reflector;
  const acesso = {
    validarUsuario: jest.fn().mockResolvedValue(undefined),
    empresaUnica: jest.fn().mockResolvedValue(null),
  };
  const interceptor = new MultiEmpresaInterceptor(dataSource as never, cls as never, reflector, acesso as never);
  return { interceptor, dataSource, manager, armazenado, acesso };
}

function contexto(req: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const handler = (valor: unknown = 'ok'): CallHandler => ({ handle: jest.fn(() => of(valor)) });

describe('MultiEmpresaInterceptor', () => {
  beforeAll(() => EvoExtensionPoints.replace('tenant_db_context', multiEmpresaRunner));

  it('roda a requisição dentro da transação da empresa e publica manager e empresa no CLS', async () => {
    const { interceptor, manager, armazenado, acesso } = montar();
    const req = { headers: { 'x-evo-tenant-id': A, authorization: 'Bearer tok' } };

    const saida = await lastValueFrom(await interceptor.intercept(contexto(req), handler('dados')));

    expect(saida).toBe('dados');
    expect(acesso.validarUsuario).toHaveBeenCalledWith('tok', A);
    expect(manager.query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', ['app.empresa_id', A]);
    expect(armazenado[TENANT_DB_MANAGER_CLS_KEY]).toBe(manager);
    expect(armazenado[EMPRESA_CLS_KEY]).toBe(A);
  });

  it('sem cabeçalho, usuário com UMA só empresa: usa essa empresa (como o CRM e o Core) e valida o vínculo', async () => {
    const { interceptor, manager, acesso } = montar();
    acesso.empresaUnica.mockResolvedValue(A);
    const req = { headers: { authorization: 'Bearer tok' } };

    await lastValueFrom(await interceptor.intercept(contexto(req), handler()));

    expect(acesso.empresaUnica).toHaveBeenCalledWith('tok');
    expect(acesso.validarUsuario).toHaveBeenCalledWith('tok', A);
    expect(manager.query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', ['app.empresa_id', A]);
  });

  it('sem cabeçalho e com chave de integração: continua 400 (serviço precisa dizer a empresa)', async () => {
    const { interceptor, acesso } = montar();
    acesso.empresaUnica.mockResolvedValue(A);
    const req = { headers: { 'x-integration-api-key': 'k' } };

    await expect(interceptor.intercept(contexto(req), handler())).rejects.toBeInstanceOf(BadRequestException);
    expect(acesso.empresaUnica).not.toHaveBeenCalled();
  });

  it('sem cabeçalho de empresa: 400, e o handler nem roda', async () => {
    const { interceptor } = montar();
    const h = handler();

    await expect(
      interceptor.intercept(contexto({ headers: { authorization: 'Bearer tok' } }), h),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('empresa que não é uuid: 400', async () => {
    const { interceptor } = montar();

    await expect(
      interceptor.intercept(contexto({ headers: { 'x-evo-tenant-id': 'abc', authorization: 'Bearer t' } }), handler()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('usuário sem vínculo com a empresa: 403 do serviço de acesso', async () => {
    const { interceptor, acesso } = montar();
    acesso.validarUsuario.mockRejectedValue(new ForbiddenException('Sem acesso a esta empresa'));

    await expect(
      interceptor.intercept(contexto({ headers: { 'x-evo-tenant-id': B, authorization: 'Bearer t' } }), handler()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('chave de integração (serviço) é confiável: não consulta vínculo', async () => {
    const { interceptor, acesso } = montar();
    const req = { headers: { 'x-evo-tenant-id': A, 'x-integration-api-key': 'k' } };

    await lastValueFrom(await interceptor.intercept(contexto(req), handler()));

    expect(acesso.validarUsuario).not.toHaveBeenCalled();
  });

  it('credencial sem Bearer (vínculo não verificável) é recusada', async () => {
    const { interceptor } = montar();

    await expect(
      interceptor.intercept(
        contexto({ headers: { 'x-evo-tenant-id': A, api_access_token: 'x' } }),
        handler(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rota pública sem empresa segue sem transação e sem acesso às tabelas isoladas', async () => {
    const { interceptor, dataSource } = montar({ publica: true });
    const h = handler('saude');

    const saida = await lastValueFrom(await interceptor.intercept(contexto({ headers: {}, path: '/health' }), h));

    expect(saida).toBe('saude');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('link curto: a empresa vem do código do link', async () => {
    const { interceptor, dataSource, armazenado } = montar({ publica: true, resolvida: A });

    await lastValueFrom(await interceptor.intercept(contexto({ headers: {}, path: '/link/aBc123' }), handler()));

    expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining('chordata_resolver_empresa'), [
      'short_links',
      'short_code',
      'aBc123',
    ]);
    expect(armazenado[EMPRESA_CLS_KEY]).toBe(A);
  });

  it('link curto desconhecido: segue sem empresa (o redirect responde 404 por conta própria)', async () => {
    const { interceptor, dataSource } = montar({ publica: true, resolvida: null });

    await lastValueFrom(await interceptor.intercept(contexto({ headers: {}, path: '/link/zzz' }), handler()));

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
