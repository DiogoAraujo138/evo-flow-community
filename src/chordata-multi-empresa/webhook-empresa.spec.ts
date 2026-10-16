const mockInsert = jest.fn();
jest.mock('@clickhouse/client', () => ({
  createClient: jest.fn(() => ({ insert: mockInsert, close: jest.fn() })),
}));

import { ClickHouseEmpresa } from './clickhouse-empresa';
import { FonteDeEmpresas } from './fonte-de-empresas';
import { WebhookEmpresaService, WebhookSemEmpresaError } from './webhook-empresa.service';
import { EventProcessService, InvalidEnvelopeError } from '../runners/event-process/services/event-process.service';
import { ClickHouseWriterService } from '../runners/event-process/services/clickhouse-writer.service';
import { PayloadNormalizerService } from '../runners/event-receiver/services/payload-normalizer.service';
import { isEventsReceivedContract } from '../shared/broker/contracts/events-received.contract';
import { WebhooksController } from '../runners/event-receiver/controllers/webhooks.controller';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function dataSource(empresas: Record<string, string>) {
  const ds = {
    query: jest.fn(async (_sql: string, [slug]: [string]) => (empresas[slug] ? [{ id: empresas[slug] }] : [])),
  };
  FonteDeEmpresas.configurar(ds as never);
  return ds;
}

describe('webhook por empresa (caminho /webhooks/empresa/<slug>/...)', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  describe('WebhookEmpresaService', () => {
    it('desligado devolve o caminho como veio, sem consultar o banco', async () => {
      delete process.env.MULTI_EMPRESA;
      const ds = dataSource({});
      const r = await new WebhookEmpresaService().resolver('evolution-api/x');
      expect(r).toEqual({ caminho: 'evolution-api/x' });
      expect(ds.query).not.toHaveBeenCalled();
    });

    it('ligado tira o prefixo e acha a empresa pelo slug', async () => {
      process.env.MULTI_EMPRESA = 'on';
      dataSource({ vetconnection: A });
      const r = await new WebhookEmpresaService().resolver(
        'empresa/VetConnection/evolution-api/inst',
      );
      expect(r).toEqual({ caminho: 'evolution-api/inst', empresaId: A });
    });

    it.each([['evolution-api'], ['empresa'], ['empresa/'], ['empresa/nao-existe/evolution-api'], ["empresa/a'; DROP--/x"]])(
      'ligado recusa %p (sem empresa válida)',
      async caminho => {
        process.env.MULTI_EMPRESA = 'on';
        await expect((dataSource({ a: A }), new WebhookEmpresaService()).resolver(caminho)).rejects.toBeInstanceOf(
          WebhookSemEmpresaError,
        );
      },
    );
  });

  describe('envelope', () => {
    it('leva a empresa quando há e continua válido no contrato strict; sem empresa não ganha a chave', () => {
      const n = new PayloadNormalizerService();
      const base = { platform: 'evolution-api' as const, rawPayload: '{}', headers: {}, sourceIp: '1.1.1.1' };
      const com = n.build({ ...base, empresaId: A });
      expect(com.empresaId).toBe(A);
      expect(isEventsReceivedContract(com)).toBe(true);
      expect('empresaId' in n.build(base)).toBe(false);
      expect(isEventsReceivedContract({ ...com, empresaId: 'nao-uuid' })).toBe(false);
    });
  });

  describe('WebhooksController', () => {
    function chamar(empresas: WebhookEmpresaService | undefined) {
      const intake = { intake: jest.fn().mockResolvedValue(undefined) };
      const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
      const metrics = { incError: jest.fn(), observeRequestDuration: jest.fn(), incThroughput: jest.fn() };
      const ctrl = new WebhooksController(logger as never, intake as never, metrics as never, empresas);
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };
      const req = {
        params: { splat: ['empresa', 'a', 'evolution-api'] },
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{}'),
        ip: '2.2.2.2',
        socket: {},
      };
      return { ctrl, intake, res, req };
    }

    it('empresa conhecida: manda o caminho sem prefixo e a empresa ao intake', async () => {
      process.env.MULTI_EMPRESA = 'on';
      const { ctrl, intake, res, req } = chamar((dataSource({ a: A }), new WebhookEmpresaService()));
      await ctrl.receive(req as never, res as never);
      expect(intake.intake).toHaveBeenCalledWith(expect.objectContaining({ pathSegment: 'evolution-api', empresaId: A }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('empresa desconhecida: 404 e nada é publicado', async () => {
      process.env.MULTI_EMPRESA = 'on';
      const { ctrl, intake, res, req } = chamar((dataSource({ b: B }), new WebhookEmpresaService()));
      await ctrl.receive(req as never, res as never);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(intake.intake).not.toHaveBeenCalled();
    });

    it('sem o serviço (Evo comunitário) o caminho segue igual', async () => {
      const { ctrl, intake, res, req } = chamar(undefined);
      await ctrl.receive(req as never, res as never);
      expect(intake.intake).toHaveBeenCalledWith(expect.objectContaining({ pathSegment: 'empresa/a/evolution-api' }));
    });
  });

  describe('EventProcessService', () => {
    const envelope = (extra: object = {}) => ({
      platform: 'evolution-api',
      rawPayload: '{"x":1}',
      headers: {},
      receivedAt: '2026-06-08T12:00:00.000Z',
      sourceIp: '203.0.113.10',
      ingestionId: '00000000-0000-4000-8000-000000000000',
      correlationId: '11111111-1111-4111-8111-111111111111',
      ...extra,
    });
    function servico() {
      const computeHash = jest.fn((p: string) => `h:${p}`);
      const enqueue = jest.fn();
      const s = new EventProcessService(
        { for: () => ({ validate: () => true }) } as never,
        { signatureInvalid: { inc: jest.fn() }, eventDuplicatesDropped: { inc: jest.fn() } } as never,
        { computeHash, checkAndMark: jest.fn().mockResolvedValue(true) } as never,
        { enrich: async (e: object) => ({ ...e, enrichment: {} }) } as never,
        { enqueue } as never,
      );
      return { s, computeHash, enqueue };
    }
    beforeEach(() => {
      process.env.MULTI_EMPRESA = 'on';
      ClickHouseEmpresa.reiniciarParaTestes();
      ClickHouseEmpresa.configurar({
        prepararBanco: jest.fn().mockResolvedValue(undefined),
        criarClienteParaBanco: jest.fn(),
      } as never);
      ClickHouseEmpresa.definirBuscaDeSlug(async id => (id === A ? 'a' : null));
    });
    afterEach(() => ClickHouseEmpresa.reiniciarParaTestes());

    it('ligado sem empresaId: descarta de vez (erro permanente) e não grava', async () => {
      const { s, enqueue } = servico();
      await expect(s.handle(envelope())).rejects.toBeInstanceOf(InvalidEnvelopeError);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('empresa desconhecida: erro permanente, não reentrega para sempre', async () => {
      const { s, enqueue } = servico();
      await expect(s.handle(envelope({ empresaId: B }))).rejects.toBeInstanceOf(InvalidEnvelopeError);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('empresa válida: grava e a empresa entra no hash de duplicata', async () => {
      const { s, enqueue, computeHash } = servico();
      await s.handle(envelope({ empresaId: A }));
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ empresaId: A }));
      expect(computeHash).toHaveBeenCalledWith(`${A}\n{"x":1}`);
    });

    it('desligado não exige empresa (Evo comunitário)', async () => {
      delete process.env.MULTI_EMPRESA;
      const { s, enqueue } = servico();
      await s.handle(envelope());
      expect(enqueue).toHaveBeenCalled();
    });
  });

  describe('ClickHouseWriterService', () => {
    it('divide o lote por empresa: cada uma grava só no cliente do seu banco', async () => {
      process.env.MULTI_EMPRESA = 'on';
      mockInsert.mockReset().mockResolvedValue(undefined);
      const doBanco: Record<string, { insert: jest.Mock }> = {
        a: { insert: jest.fn().mockResolvedValue(undefined) },
        b: { insert: jest.fn().mockResolvedValue(undefined) },
      };
      ClickHouseEmpresa.reiniciarParaTestes();
      ClickHouseEmpresa.configurar({
        prepararBanco: jest.fn().mockResolvedValue(undefined),
        criarClienteParaBanco: jest.fn((banco: string) => doBanco[banco === 'evo_campaign_b' ? 'b' : 'a']),
      } as never);
      ClickHouseEmpresa.definirBuscaDeSlug(async id => (id === A ? 'padrao' : 'b'));

      const w = new ClickHouseWriterService(
        { publish: jest.fn() } as never,
        {
          clickhouseInsertLatencyMs: { observe: jest.fn() },
          clickhouseBatchSize: { observe: jest.fn() },
          clickhouseRetryTotal: { inc: jest.fn() },
          clickhouseTerminalFailureTotal: { inc: jest.fn() },
        } as never,
      );
      const ev = (n: number, empresaId: string) =>
        ({
          platform: 'evolution-api',
          rawPayload: `{"n":${n}}`,
          headers: {},
          receivedAt: '2026-06-10T12:00:00.000Z',
          sourceIp: '1.1.1.1',
          ingestionId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
          correlationId: `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`,
          empresaId,
          enrichment: {},
        }) as never;
      w.enqueue(ev(1, A));
      w.enqueue(ev(2, B));
      w.enqueue(ev(3, A));
      await w.onModuleDestroy();

      expect(doBanco.a.insert).toHaveBeenCalledTimes(1);
      expect(doBanco.a.insert.mock.calls[0][0].values).toHaveLength(2);
      expect(doBanco.b.insert).toHaveBeenCalledTimes(1);
      expect(doBanco.b.insert.mock.calls[0][0].values).toHaveLength(1);
      expect(mockInsert).not.toHaveBeenCalled(); // o cliente do banco padrão não é usado
    });
  });
});
