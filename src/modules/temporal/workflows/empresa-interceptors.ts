/**
 * Interceptadores de WORKFLOW (rodam no sandbox do Temporal: só podem importar @temporalio/workflow).
 * Repassam o cabeçalho da empresa que o cliente colocou ao iniciar o workflow para cada atividade e
 * workflow filho que ele agendar. Registrados em `Worker.create({ interceptors: { workflowModules } })`
 * apenas com MULTI_EMPRESA=on (ver chordata-multi-empresa/temporal.ts).
 */
import type {
  ActivityInput,
  LocalActivityInput,
  Next,
  StartChildWorkflowExecutionInput,
  WorkflowExecuteInput,
  WorkflowInboundCallsInterceptor,
  WorkflowInterceptors,
  WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow';

const EMPRESA_HEADER = 'x-evo-tenant-id';

export const interceptors = (): WorkflowInterceptors => {
  let empresa: unknown;

  const inbound: WorkflowInboundCallsInterceptor = {
    async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>) {
      empresa = input.headers?.[EMPRESA_HEADER];
      return next(input);
    },
  };

  const comEmpresa = <T extends { headers: Record<string, unknown> }>(input: T): T =>
    empresa ? ({ ...input, headers: { ...input.headers, [EMPRESA_HEADER]: empresa } } as T) : input;

  const outbound: WorkflowOutboundCallsInterceptor = {
    async scheduleActivity(input: ActivityInput, next) {
      return next(comEmpresa(input as never));
    },
    async scheduleLocalActivity(input: LocalActivityInput, next) {
      return next(comEmpresa(input as never));
    },
    async startChildWorkflowExecution(input: StartChildWorkflowExecutionInput, next) {
      return next(comEmpresa(input as never));
    },
  };

  return { inbound: [inbound], outbound: [outbound] };
};
