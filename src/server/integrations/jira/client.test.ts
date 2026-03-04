import { describe, expect, it, vi } from 'vitest';
import { JiraMcpIssueSourceIntegration } from './client';

function makeResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('jira issue source integration', () => {
  it('normalizes Jira issue payload into task-ready fields', async () => {
    const fetcher = vi.fn(async () => makeResponse(200, {
      key: 'AB-1',
      self: 'https://jira.example.com/rest/api/3/issue/AB-1',
      fields: {
        summary: 'Fix login bug',
        description: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'The login button fails.' }]
            }
          ]
        }
      }
    }));
    const integration = new JiraMcpIssueSourceIntegration({
      baseUrl: 'https://jira.example.com',
      authToken: 'token'
    }, fetcher);

    const issue = await integration.fetchIssue('ab-1', 'tenant_local');

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(issue.issueKey).toBe('AB-1');
    expect(issue.title).toBe('Fix login bug');
    expect(issue.body).toBe('The login button fails.');
    expect(issue.url).toBe('https://jira.example.com/browse/AB-1');
  });

  it('retries retryable Jira failures and preserves explicit retry budget', async () => {
    const fetcher = vi.fn(async () => makeResponse(503, { errorMessages: 'service unavailable' }));
    const integration = new JiraMcpIssueSourceIntegration({
      baseUrl: 'https://jira.example.com',
      authToken: 'token',
      maxAttempts: 3,
      retryDelayMs: 1
    }, fetcher);

    await expect(integration.fetchIssue('ab-2', 'tenant_local')).rejects.toThrow(
      'Failed to load Jira issue AB-2'
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('maps 404 into an actionable operator-facing error', async () => {
    const fetcher = vi.fn(async () => makeResponse(404, { message: 'not found' }));
    const integration = new JiraMcpIssueSourceIntegration({
      baseUrl: 'https://jira.example.com',
      authToken: 'token'
    }, fetcher);

    await expect(integration.fetchIssue('AB-3', 'tenant_local')).rejects.toMatchObject({
      message: 'Jira issue AB-3 not found: not found.'
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('validates issue keys early before contacting Jira', async () => {
    const fetcher = vi.fn();
    const integration = new JiraMcpIssueSourceIntegration({
      baseUrl: 'https://jira.example.com',
      authToken: 'token'
    }, fetcher);

    await expect(integration.fetchIssue('bad-key', 'tenant_local')).rejects.toThrow('Invalid Jira issue key.');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('logs sanitized lifecycle details when Jira endpoint is unreachable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = vi.fn(async () => {
      throw new Error('network down; Authorization: Bearer super-secret-token');
    });
    const integration = new JiraMcpIssueSourceIntegration({
      baseUrl: 'https://jira.example.com',
      authToken: 'token',
      maxAttempts: 1
    }, fetcher);

    await expect(integration.fetchIssue('AB-9', 'tenant_local')).rejects.toThrow('Unable to reach Jira issue endpoint.');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[jira:fetch] network_unreachable'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[jira:fetch] request_failed'));
    expect(warnSpy).toHaveBeenCalledWith(expect.not.stringContaining('super-secret-token'));
    expect(errorSpy).toHaveBeenCalledWith(expect.not.stringContaining('super-secret-token'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[REDACTED]'));
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
