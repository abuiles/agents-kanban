import { describe, expect, it } from 'vitest';
import { resolveSlackIntentSettings } from './intent';
import type { IntegrationConfig } from '../../../ui/domain/types';

function config(input: Partial<IntegrationConfig> & Pick<IntegrationConfig, 'id' | 'tenantId' | 'scopeType' | 'pluginKind' | 'enabled' | 'settings' | 'createdAt' | 'updatedAt'>): IntegrationConfig {
  return {
    scopeId: undefined,
    secretRef: undefined,
    ...input
  };
}

describe('slack intent settings resolution', () => {
  it('uses precedence channel > repo > tenant and defaults model to gpt-5-nano', () => {
    const configs: IntegrationConfig[] = [
      config({
        id: 'tenant',
        tenantId: 'tenant_local',
        scopeType: 'tenant',
        pluginKind: 'slack',
        enabled: true,
        settings: { intentModel: 'gpt-5.3-codex-spark', intentClarifyMaxTurns: 6 },
        createdAt: '',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }),
      config({
        id: 'repo',
        tenantId: 'tenant_local',
        scopeType: 'repo',
        scopeId: 'repo_alpha',
        pluginKind: 'slack',
        enabled: true,
        settings: { intentModel: 'gpt-5.3-codex', intentClarifyMaxTurns: 5 },
        createdAt: '',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }),
      config({
        id: 'channel',
        tenantId: 'tenant_local',
        scopeType: 'channel',
        scopeId: 'C123',
        pluginKind: 'slack',
        enabled: true,
        settings: { intentModel: 'gpt-5.1-codex-mini', intentClarifyMaxTurns: 4 },
        createdAt: '',
        updatedAt: '2026-01-03T00:00:00.000Z'
      })
    ];
    const resolved = resolveSlackIntentSettings(configs, {
      tenantId: 'tenant_local',
      repoId: 'repo_alpha',
      channelId: 'C123'
    });
    expect(resolved.intentModel).toBe('gpt-5.1-codex-mini');
    expect(resolved.intentClarifyMaxTurns).toBe(4);
  });

  it('falls back to default parser model when no override exists', () => {
    const resolved = resolveSlackIntentSettings([], {
      tenantId: 'tenant_local',
      repoId: 'repo_alpha',
      channelId: 'C123'
    });
    expect(resolved.intentModel).toBe('gpt-5-nano');
    expect(resolved.intentClarifyMaxTurns).toBe(4);
  });
});
