import { describe, expect, it } from 'vitest';
import { buildProviderCredentialId, getRepoIdentityKey, normalizeProviderCredential, normalizeRepo } from '../../shared/scm';

describe('normalizeRepo', () => {
  it('fills GitHub SCM defaults for legacy repos', () => {
    const repo = normalizeRepo({
      repoId: 'repo_demo',
      slug: 'abuiles/minions',
      defaultBranch: 'main',
      baselineUrl: 'https://minions.example.com',
      enabled: true,
      createdAt: '2026-03-02T00:00:00.000Z',
      updatedAt: '2026-03-02T00:00:00.000Z'
    });

    expect(repo.scmProvider).toBe('github');
    expect(repo.scmBaseUrl).toBe('https://github.com');
    expect(repo.projectPath).toBe('abuiles/minions');
    expect(repo.slug).toBe('abuiles/minions');
    expect(repo.githubAuthMode).toBe('kv_pat');
  });

  it('uses provider-neutral fields for repo identity', () => {
    const legacyKey = getRepoIdentityKey({
      slug: 'abuiles/minions',
      projectPath: undefined,
      scmProvider: undefined,
      scmBaseUrl: undefined
    });
    const normalizedKey = getRepoIdentityKey({
      slug: 'legacy-alias',
      projectPath: 'abuiles/minions',
      scmProvider: 'github',
      scmBaseUrl: 'https://github.com/'
    });

    expect(normalizedKey).toBe(legacyKey);
  });
});

describe('normalizeProviderCredential', () => {
  it('normalizes provider-host scope into a stable credential id', () => {
    const credential = normalizeProviderCredential({
      credentialId: '',
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com/',
      host: '',
      authType: 'kv_pat',
      secretRef: {
        storage: 'kv',
        key: 'gitlab_pat'
      },
      createdAt: '2026-03-02T00:00:00.000Z',
      updatedAt: '2026-03-02T00:00:00.000Z'
    });

    expect(credential.credentialId).toBe(buildProviderCredentialId('gitlab', 'https://gitlab.example.com'));
    expect(credential.host).toBe('gitlab.example.com');
    expect(credential.scmBaseUrl).toBe('https://gitlab.example.com');
  });
});
