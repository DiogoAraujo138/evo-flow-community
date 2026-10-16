import { proxyActivities } from '@temporalio/workflow';

const { qualEmpresa } = proxyActivities<{ qualEmpresa(): Promise<string | null> }>({
  startToCloseTimeout: '30 seconds',
});

/** Workflow de teste: devolve a empresa que a ATIVIDADE enxergou. */
export async function EcoEmpresaWorkflow(): Promise<string | null> {
  return qualEmpresa();
}
