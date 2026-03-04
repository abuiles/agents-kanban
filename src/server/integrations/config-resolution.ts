import type { IntegrationConfig, IntegrationPluginKind } from '../../ui/domain/types';

export type IntegrationResolutionInput = {
  tenantId: string;
  pluginKind: IntegrationPluginKind;
  repoId?: string;
  channelId?: string;
};

const SCOPE_PRECEDENCE = ['channel', 'repo', 'tenant'] as const;

export function resolveIntegrationConfig(
  configs: readonly IntegrationConfig[],
  input: IntegrationResolutionInput
): IntegrationConfig | undefined {
  const filtered = configs
    .filter((config) => config.tenantId === input.tenantId && config.pluginKind === input.pluginKind && config.enabled);

  const channelMatch = filtered
    .filter((config) => config.scopeType === 'channel' && config.scopeId === input.channelId)
    .sort(sortByNewest)
    .at(0);
  if (channelMatch) {
    return channelMatch;
  }

  const repoMatch = filtered
    .filter((config) => config.scopeType === 'repo' && config.scopeId === input.repoId)
    .sort(sortByNewest)
    .at(0);
  if (repoMatch) {
    return repoMatch;
  }

  return filtered
    .filter((config) => config.scopeType === 'tenant')
    .sort(sortByNewest)
    .at(0);
}

export function resolveIntegrationConfigForScope(
  configs: readonly IntegrationConfig[],
  scope: { tenantId: string; pluginKind: IntegrationPluginKind; repoId?: string; channelId?: string; }
): IntegrationConfig | undefined {
  return resolveIntegrationConfig(configs, scope);
}

export function getPrecedenceScopeOrder() {
  return [...SCOPE_PRECEDENCE];
}

function sortByNewest(left: IntegrationConfig, right: IntegrationConfig) {
  const leftUpdated = left.updatedAt === right.updatedAt
    ? 0
    : left.updatedAt > right.updatedAt
      ? -1
      : 1;
  if (leftUpdated !== 0) {
    return leftUpdated;
  }

  return left.id.localeCompare(right.id);
}
