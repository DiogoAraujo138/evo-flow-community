import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { EmpresaDeFundoService } from '../../../chordata-multi-empresa/empresa-de-fundo.service';
import {
  IMESSAGE_BROKER,
  IMessageBroker,
  BrokerMessage,
} from '../../../shared/broker/interfaces/message-broker.interface';
import {
  CAMPAIGNS_PACK_TOPIC,
  isCampaignsPackContract,
  type CampaignsPackContract,
} from '../../../shared/broker/contracts/campaigns-pack.contract';
import { CorrelationContext } from '../../../shared/correlation/correlation.context';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { CampaignPackerService } from '../services/campaign-packer.service';
import { processWithAckPolicy } from '../../../shared/broker/consumer/process-with-ack-policy';

const LOG_CONTEXT = 'CampaignsPackConsumer';

/**
 * Broker consumer for `campaigns.pack` (story 4.1 / EVO-1215). Subscribes on
 * boot and routes each message to `CampaignPackerService`, wrapping processing
 * in the request's `correlationId` so every downstream log carries it.
 *
 * Ack/nack is delegated to the shared `processWithAckPolicy`: success → ack,
 * `TerminalError` (campaign not found, invalid audience config, deterministic
 * DB error) → nack(requeue=false), any other error → nack(requeue=true). A
 * structurally invalid payload is dropped up-front (no correlationId to bind).
 */
@Injectable()
export class CampaignsPackConsumer implements OnModuleInit {
  constructor(
    @Inject(IMESSAGE_BROKER) private readonly broker: IMessageBroker,
    private readonly packer: CampaignPackerService,
    private readonly correlation: CorrelationContext,
    private readonly logger: CustomLoggerService,
      @Optional() private readonly fundo?: EmpresaDeFundoService,
  ) {}

  /** Multi-empresa: roda o trabalho na empresa da campanha (sem multi-empresa só executa).
   *  Ligado, um erro (ex.: campanha inexistente) segue a política normal de ack/nack. */
  private executarNaEmpresa<T>(campaignId: string, trabalho: () => Promise<T>): Promise<T> {
    return this.fundo ? this.fundo.executarParaCampanha(campaignId, trabalho) : trabalho();
  }

  async onModuleInit(): Promise<void> {
    await this.broker.subscribe<CampaignsPackContract>(
      CAMPAIGNS_PACK_TOPIC,
      (msg) => this.handle(msg),
    );
    this.logger.log(`Subscribed to ${CAMPAIGNS_PACK_TOPIC}`, LOG_CONTEXT);
  }

  private async handle(
    msg: BrokerMessage<CampaignsPackContract>,
  ): Promise<void> {
    if (!isCampaignsPackContract(msg.payload)) {
      this.logger.warn(
        `Invalid ${CAMPAIGNS_PACK_TOPIC} payload (messageId=${msg.id}) — nack(requeue=false)`,
        LOG_CONTEXT,
      );
      await this.broker.nack(msg, false);
      return;
    }

    const payload = msg.payload;

    await this.correlation.runWithCorrelationId(payload.correlationId, () =>
      processWithAckPolicy(
        msg,
        this.broker,
        {
          logger: this.logger,
          context: LOG_CONTEXT,
          meta: { campaignId: payload.campaignId },
        },
        async () => {
          await this.executarNaEmpresa(payload.campaignId, () =>
            this.packer.pack(payload),
          );
        },
      ),
    );
  }
}
