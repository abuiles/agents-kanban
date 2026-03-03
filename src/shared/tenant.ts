export const DEFAULT_TENANT_ID = 'tenant_legacy';

export function normalizeTenantId(value?: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_TENANT_ID;
}

export function normalizeTenantIdStrict(value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error('Missing tenantId.');
  }
  return trimmed;
}
