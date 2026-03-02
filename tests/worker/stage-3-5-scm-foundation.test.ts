import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Stage 3.5 SCM foundation', () => {
  it('defaults legacy GitHub repo payloads to provider-neutral SCM fields', async () => {
    const board = env.BOARD_INDEX.getByName('agentboard');
    const repo = await board.createRepo({
      slug: 'abuiles/minions',
      baselineUrl: 'https://minions.example.com',
      defaultBranch: 'main'
    });

    expect(repo).toMatchObject({
      slug: 'abuiles/minions',
      projectPath: 'abuiles/minions',
      scmProvider: 'github',
      scmBaseUrl: 'https://github.com'
    });
  });

  it('stores provider credentials by provider and host without attaching tokens to repos', async () => {
    const board = env.BOARD_INDEX.getByName('agentboard');

    const credential = await board.upsertScmCredential({
      scmProvider: 'github',
      host: 'github.example.com',
      label: 'GitHub Enterprise',
      token: 'ghp_secret'
    });

    expect(credential).toMatchObject({
      scmProvider: 'github',
      host: 'github.example.com',
      label: 'GitHub Enterprise',
      hasSecret: true
    });
    expect(Object.prototype.hasOwnProperty.call(credential, 'token')).toBe(false);

    const listed = await board.listScmCredentials();
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          credentialId: 'github:github.example.com',
          scmProvider: 'github',
          host: 'github.example.com'
        })
      ])
    );

    expect(await board.getScmCredentialSecret('github', 'github.example.com')).toBe('ghp_secret');
  });

  it('updates repo projectPath while preserving the legacy slug alias', async () => {
    const board = env.BOARD_INDEX.getByName('agentboard');
    const repo = await board.createRepo({
      slug: 'acme/original',
      baselineUrl: 'https://original.example.com'
    });

    const updated = await board.updateRepo(repo.repoId, {
      projectPath: 'acme/renamed'
    });

    expect(updated.projectPath).toBe('acme/renamed');
    expect(updated.slug).toBe('acme/renamed');
    expect(updated.scmProvider).toBe('github');
    expect(updated.scmBaseUrl).toBe('https://github.com');
  });
});
