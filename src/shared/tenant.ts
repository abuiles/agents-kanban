export const DEFAULT_TENANT_ID = 'tenant_legacy';

export function normalizeTenantId(value?: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_TENANT_ID;
}
