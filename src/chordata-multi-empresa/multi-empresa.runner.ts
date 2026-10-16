import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { TenantDbContextImpl } from '../evo-extension-points';
import { EMPRESA_GUC, UUID_RE } from './multi-empresa.constants';

export class EmpresaAusenteError extends BadRequestException {
  constructor() {
    super('Empresa não definida: informe o cabeçalho X-Evo-Tenant-Id');
  }
}

/**
 * Implementação do ponto de extensão `tenant_db_context`: roda o trabalho numa transação em que a empresa
 * está aplicada (`set_config(..., true)` = vale só nesta transação). O RLS do Postgres filtra por ela.
 * Sem empresa válida o trabalho NÃO roda: falha explícita, nunca "tudo".
 */
export const multiEmpresaRunner: TenantDbContextImpl = <T>(
  dataSource: DataSource,
  empresaId: string | null,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> => {
  if (!empresaId || !UUID_RE.test(empresaId)) {
    return Promise.reject(new EmpresaAusenteError());
  }
  return dataSource.transaction(async manager => {
    await manager.query('SELECT set_config($1, $2, true)', [
      EMPRESA_GUC,
      empresaId,
    ]);
    return work(manager);
  });
};
