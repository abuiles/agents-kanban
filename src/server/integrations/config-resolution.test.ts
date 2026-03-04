import { describe, expect, it } from 'vitest';
import type { IntegrationConfig, IntegrationPluginKind } from '../../ui/domain/types';
import { getPrecedenceScopeOrder, resolveIntegrationConfig } from './config-resolution';

describe('integration config resolution', () => {
  const tenantId = 'tenant_local';
  const pluginKind: IntegrationPluginKind = 'slack';

  function config(overrides: Partial<IntegrationConfig>): IntegrationConfig {
    return {
      id: overrides.id ?? `config_${Math.random().toString(16).slice(2, 8)}`,
      tenantId,
      scopeType: 'tenant',
      pluginKind,
      enabled: true,
      settings: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides
    };
  }

  it('resolves by strict scope precedence channel > repo > tenant', () => {
    const configs: IntegrationConfig[] = [
      config({ id: 'tenant', scopeType: 'tenant', scopeId: undefined }),
      config({ id: 'repo', scopeType: 'repo', scopeId: 'repo-1' }),
      config({ id: 'channel', scopeType: 'channel', scopeId: 'C-1' })
    ];
    const resolved = resolveIntegrationConfig(configs, {
      tenantId,
      pluginKind,
      repoId: 'repo-1',
      channelId: 'C-1'
    });

    expect(resolved?.id).toBe('channel');
  });

  it('falls back to repo when channel does not match', () => {
    const configs: IntegrationConfig[] = [
      config({ id: 'tenant', scopeType: 'tenant', scopeId: undefined }),
      config({ id: 'repo', scopeType: 'repo', scopeId: 'repo-1' })
    ];
    const resolved = resolveIntegrationConfig(configs, {
      tenantId,
      pluginKind,
      repoId: 'repo-1',
      channelId: 'C-missing'
    });

    expect(resolved?.id).toBe('repo');
  });

  it('falls back to tenant when channel/repo do not match', () => {
    const configs: IntegrationConfig[] = [
      config({ id: 'tenant', scopeType: 'tenant', scopeId: undefined, updatedAt: '2026-01-01T00:00:00.000Z' }),
      config({ id: 'repo', scopeType: 'repo', scopeId: 'repo-other', updatedAt: '2026-01-03T00:00:00.000Z' })
    ];
    const resolved = resolveIntegrationConfig(configs, {
      tenantId,
      pluginKind,
      repoId: 'repo-1',
      channelId: 'C-1'
    });

    expect(resolved?.id).toBe('tenant');
  });

  it('ignores disabled configs during resolution', () => {
    const configs: IntegrationConfig[] = [
      config({ id: 'tenant', scopeType: 'tenant', enabled: true }),
      config({ id: 'repo', scopeType: 'repo', scopeId: 'repo-1', enabled: false })
    ];

    const resolved = resolveIntegrationConfig(configs, {
      tenantId,
      pluginKind,
      repoId: 'repo-1',
      channelId: 'C-1'
    });

    expect(resolved?.id).toBe('tenant');
  });

  it('returns the newest matching config for equal scope precedence', () => {
    const configs: IntegrationConfig[] = [
      config({ id: 'tenant-old', scopeType: 'tenant', updatedAt: '2026-01-01T00:00:00.000Z' }),
      config({ id: 'tenant-new', scopeType: 'tenant', updatedAt: '2026-01-03T00:00:00.000Z' })
    ];

    const resolved = resolveIntegrationConfig(configs, {
      tenantId,
      pluginKind,
      repoId: 'repo-1',
      channelId: 'C-1'
    });

    expect(resolved?.id).toBe('tenant-new');
  });

  it('reports precedence order as channel > repo > tenant', () => {
    expect(getPrecedenceScopeOrder()).toEqual(['channel', 'repo', 'tenant']);
  });
});
