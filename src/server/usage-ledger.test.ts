import { describe, expect, it } from 'vitest';
import { writeUsageLedgerEntries } from './usage-ledger';

type InsertedRow = Record<string, unknown>;

class FakeD1Statement {
  private bindings: unknown[] = [];

  constructor(
    public readonly sql: string,
    private readonly execute: (sql: string, bindings: unknown[]) => Promise<{ results?: unknown[] }>
  ) {}

  bind(...values: unknown[]) {
    this.bindings = values;
    return this;
  }

  async run() {
    return this.execute(this.sql, this.bindings);
  }

  async all<T>() {
    return this.execute(this.sql, this.bindings) as Promise<{ results: T[] }>;
  }
}

class FakeUsageDb {
  rows: InsertedRow[] = [];

  prepare(sql: string) {
    return new FakeD1Statement(sql, async (statement, bindings) => this.execute(statement, bindings));
  }

  private async execute(sql: string, bindings: unknown[]): Promise<{ results?: unknown[] }> {
    if (sql.includes('FROM sqlite_master')) {
      return { results: [{ name: 'usage_ledger_entries' }] };
    }
    if (sql.startsWith('PRAGMA table_info')) {
      return {
        results: [
          { name: 'id' },
          { name: 'tenant_id' },
          { name: 'repo_id' },
          { name: 'task_id' },
          { name: 'run_id' },
          { name: 'at' },
          { name: 'category' },
          { name: 'quantity' },
          { name: 'unit' },
          { name: 'source' },
          { name: 'metadata' },
          { name: 'rate_version' },
          { name: 'estimated_cost_usd' },
          { name: 'unit_rate_usd' }
        ]
      };
    }
    if (sql.startsWith('INSERT INTO')) {
      const columnList = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((value) => value.trim().replaceAll('"', ''));
      const row: InsertedRow = {};
      for (let index = 0; index < columnList.length; index += 1) {
        row[columnList[index]] = bindings[index];
      }
      this.rows.push(row);
      return {};
    }
    throw new Error(`Unhandled SQL in fake DB: ${sql}`);
  }
}

describe('usage-ledger writes', () => {
  it('writes tenant-attributed entries with source and rate-version metadata', async () => {
    const db = new FakeUsageDb();
    const env = { USAGE_DB: db } as unknown as Env;

    await writeUsageLedgerEntries(env, [
      {
        tenantId: 'tenant_acme',
        repoId: 'repo_1',
        taskId: 'task_1',
        runId: 'run_1',
        category: 'workflow_execution',
        quantity: 1,
        source: 'workflow',
        metadata: { event: 'start' }
      }
    ]);

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].tenant_id).toBe('tenant_acme');
    expect(db.rows[0].source).toBe('workflow');
    expect(db.rows[0].rate_version).toBe('v1');
    expect(String(db.rows[0].metadata)).toContain('"rateVersion":"v1"');
  });

  it('is a no-op when a usage database binding is unavailable', async () => {
    const env = {} as Env;
    await expect(
      writeUsageLedgerEntries(env, [
        {
          tenantId: 'tenant_acme',
          category: 'worker_request',
          quantity: 1,
          source: 'worker'
        }
      ])
    ).resolves.toBe(0);
  });
});
