import { describe, expect, it } from 'vitest';
import { getRunUsage, getTenantRunUsage, getTenantUsageSummary } from './usage-reporting';

type LedgerRow = {
  id: string;
  tenant_id: string;
  repo_id: string;
  task_id: string;
  run_id: string;
  at: string;
  category: string;
  quantity: number;
  unit: string;
  source: string;
  rate_version: string;
  estimated_cost_usd: number;
  metadata?: string;
};

class FakeD1Statement {
  private bindings: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly execute: (sql: string, bindings: unknown[]) => Array<Record<string, unknown>>
  ) {}

  bind(...bindings: unknown[]) {
    this.bindings = bindings;
    return this;
  }

  async all<T>() {
    return { results: this.execute(this.sql, this.bindings) as T[] };
  }

  async first<T>() {
    return (this.execute(this.sql, this.bindings)[0] as T | undefined) ?? null;
  }
}

class FakeD1Database {
  constructor(private readonly rows: LedgerRow[]) {}

  prepare(sql: string) {
    return new FakeD1Statement(sql, (statement, bindings) => this.execute(statement, bindings));
  }

  private execute(sql: string, bindings: unknown[]): Array<Record<string, unknown>> {
    if (sql.includes('sqlite_master')) {
      return [{ name: 'usage_ledger_entries' }];
    }
    if (sql.includes('PRAGMA table_info')) {
      return [
        'id',
        'tenant_id',
        'repo_id',
        'task_id',
        'run_id',
        'at',
        'category',
        'quantity',
        'unit',
        'source',
        'rate_version',
        'estimated_cost_usd',
        'metadata'
      ].map((name) => ({ name }));
    }
    if (sql.includes('COUNT(*) AS count')) {
      const runId = String(bindings[0] ?? '');
      return [{ count: this.rows.filter((row) => row.run_id === runId).length }];
    }
    if (sql.includes('WHERE "run_id" = ?') && sql.includes('ORDER BY "at" ASC')) {
      const runId = String(bindings[0] ?? '');
      return this.rows
        .filter((row) => row.run_id === runId)
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((row) => ({
          id: row.id,
          tenantId: row.tenant_id,
          repoId: row.repo_id,
          taskId: row.task_id,
          runId: row.run_id,
          at: row.at,
          category: row.category,
          quantity: row.quantity,
          unit: row.unit,
          source: row.source,
          rateVersion: row.rate_version,
          estimatedCostUsd: row.estimated_cost_usd,
          metadata: row.metadata
        }));
    }
    if (sql.includes('WHERE "run_id" = ?')) {
      const runId = String(bindings[0] ?? '');
      const subset = this.rows.filter((row) => row.run_id === runId);
      return [buildAggregateRow(subset)];
    }
    if (sql.includes('GROUP BY "run_id"')) {
      const tenantId = String(bindings[0] ?? '');
      const numericTail = [...bindings].reverse().filter((value) => typeof value === 'number') as number[];
      const offset = numericTail[0] ?? 0;
      const limit = numericTail[1] ?? 200;
      const from = typeof bindings[1] === 'string' && bindings.length > 3 ? String(bindings[1]) : undefined;
      const to = typeof bindings[2] === 'string' && bindings.length > 4 ? String(bindings[2]) : undefined;
      const subset = filterWindow(this.rows, tenantId, from, to);
      const byRun = new Map<string, LedgerRow[]>();
      for (const row of subset) {
        if (!byRun.has(row.run_id)) {
          byRun.set(row.run_id, []);
        }
        byRun.get(row.run_id)!.push(row);
      }
      return [...byRun.entries()]
        .map(([runId, runRows]) => ({
          runId,
          repoId: runRows[0].repo_id,
          taskId: runRows[0].task_id,
          firstSeenAt: runRows.map((row) => row.at).sort()[0],
          lastSeenAt: runRows.map((row) => row.at).sort().at(-1),
          ...buildAggregateRow(runRows)
        }))
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .slice(Number(offset), Number(offset) + Number(limit));
    }
    if (sql.includes('GROUP BY bucketStart')) {
      const [tenantId, from, to] = bindings as [string, string | undefined, string | undefined];
      const subset = filterWindow(this.rows, tenantId, from, to);
      const monthly = sql.includes("strftime('%Y-%m-01'");
      const byBucket = new Map<string, LedgerRow[]>();
      for (const row of subset) {
        const bucket = monthly ? row.at.slice(0, 7) + '-01' : row.at.slice(0, 10);
        if (!byBucket.has(bucket)) {
          byBucket.set(bucket, []);
        }
        byBucket.get(bucket)!.push(row);
      }
      return [...byBucket.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([bucketStart, bucketRows]) => ({ bucketStart, ...buildAggregateRow(bucketRows) }));
    }
    if (sql.includes('FROM "usage_ledger_entries"')) {
      const [tenantId, from, to] = bindings as [string, string | undefined, string | undefined];
      return [buildAggregateRow(filterWindow(this.rows, tenantId, from, to))];
    }
    throw new Error(`Unhandled fake D1 query: ${sql}`);
  }
}

function filterWindow(rows: LedgerRow[], tenantId: string, from?: string, to?: string) {
  return rows.filter((row) => {
    if (row.tenant_id !== tenantId) {
      return false;
    }
    if (from && row.at < from) {
      return false;
    }
    if (to && row.at >= to) {
      return false;
    }
    return true;
  });
}

function sumCategory(rows: LedgerRow[], category: string) {
  return rows.filter((row) => row.category === category).reduce((sum, row) => sum + row.quantity, 0);
}

function buildAggregateRow(rows: LedgerRow[]) {
  return {
    runs: new Set(rows.map((row) => row.run_id)).size,
    workflowExecutions: sumCategory(rows, 'workflow_execution'),
    workflowSteps: sumCategory(rows, 'workflow_step'),
    workflowDurationMs: sumCategory(rows, 'workflow_duration_ms'),
    sandboxRuntimeMs: sumCategory(rows, 'sandbox_runtime_ms'),
    operatorSessionMs: sumCategory(rows, 'operator_session_ms'),
    r2StorageBytes: sumCategory(rows, 'r2_storage_bytes'),
    r2WriteOps: sumCategory(rows, 'r2_write_ops'),
    r2ReadOps: sumCategory(rows, 'r2_read_ops'),
    artifactDownloads: sumCategory(rows, 'artifact_download'),
    durableObjectRequests: sumCategory(rows, 'durable_object_request'),
    durableObjectStorageBytes: sumCategory(rows, 'durable_object_storage_bytes'),
    workerRequests: sumCategory(rows, 'worker_request'),
    estimatedCostUsd: rows.reduce((sum, row) => sum + row.estimated_cost_usd, 0)
  };
}

const SEED_ROWS: LedgerRow[] = [
  {
    id: 'u_1',
    tenant_id: 'tenant_a',
    repo_id: 'repo_1',
    task_id: 'task_1',
    run_id: 'run_1',
    at: '2026-02-01T01:00:00.000Z',
    category: 'workflow_execution',
    quantity: 1,
    unit: 'count',
    source: 'workflow',
    rate_version: 'v1',
    estimated_cost_usd: 0.1
  },
  {
    id: 'u_2',
    tenant_id: 'tenant_a',
    repo_id: 'repo_1',
    task_id: 'task_1',
    run_id: 'run_1',
    at: '2026-02-01T01:01:00.000Z',
    category: 'workflow_step',
    quantity: 4,
    unit: 'count',
    source: 'workflow',
    rate_version: 'v1',
    estimated_cost_usd: 0.2
  },
  {
    id: 'u_3',
    tenant_id: 'tenant_a',
    repo_id: 'repo_1',
    task_id: 'task_2',
    run_id: 'run_2',
    at: '2026-02-02T01:00:00.000Z',
    category: 'sandbox_runtime_ms',
    quantity: 2500,
    unit: 'ms',
    source: 'sandbox',
    rate_version: 'v1',
    estimated_cost_usd: 0.5
  },
  {
    id: 'u_4',
    tenant_id: 'tenant_a',
    repo_id: 'repo_1',
    task_id: 'task_2',
    run_id: 'run_2',
    at: '2026-02-02T01:02:00.000Z',
    category: 'worker_request',
    quantity: 2,
    unit: 'count',
    source: 'worker',
    rate_version: 'v1',
    estimated_cost_usd: 0.05
  },
  {
    id: 'u_5',
    tenant_id: 'tenant_b',
    repo_id: 'repo_9',
    task_id: 'task_9',
    run_id: 'run_9',
    at: '2026-02-03T00:00:00.000Z',
    category: 'workflow_execution',
    quantity: 1,
    unit: 'count',
    source: 'workflow',
    rate_version: 'v1',
    estimated_cost_usd: 0.1
  }
];

describe('usage-reporting', () => {
  const env = { USAGE_DB: new FakeD1Database(SEED_ROWS) } as unknown as Env;

  it('builds tenant summary totals and daily buckets', async () => {
    const response = await getTenantUsageSummary(
      new URL('https://minions.example.test/api/tenant-usage?tenantId=tenant_a&from=2026-02-01T00:00:00.000Z&to=2026-02-03T00:00:00.000Z&granularity=daily'),
      env
    );

    expect(response.totals.runs).toBe(2);
    expect(response.totals.workflowExecutions).toBe(1);
    expect(response.totals.workflowSteps).toBe(4);
    expect(response.totals.sandboxRuntimeMs).toBe(2500);
    expect(response.totals.workerRequests).toBe(2);
    expect(response.totals.estimatedCostUsd).toBeCloseTo(0.85);
    expect(response.series).toHaveLength(2);
  });

  it('builds monthly buckets and run-level usage list', async () => {
    const summary = await getTenantUsageSummary(
      new URL('https://minions.example.test/api/tenant-usage?tenantId=tenant_a&groupBy=month'),
      env
    );
    const runs = await getTenantRunUsage(
      new URL('https://minions.example.test/api/tenant-usage/runs?tenantId=tenant_a&limit=10&offset=0'),
      env
    );

    expect(summary.granularity).toBe('month');
    expect(summary.series).toHaveLength(1);
    expect(runs.runs).toHaveLength(2);
    expect(runs.runs[0].runId).toBe('run_2');
    expect(runs.runs[0].totals.estimatedCostUsd).toBeCloseTo(0.55);
  });

  it('returns run usage detail with reconciliation', async () => {
    const runUsage = await getRunUsage('run_1', env);

    expect(runUsage.runId).toBe('run_1');
    expect(runUsage.entries).toHaveLength(2);
    expect(runUsage.totals.workflowExecutions).toBe(1);
    expect(runUsage.totals.workflowSteps).toBe(4);
    expect(runUsage.reconciliation.reconciles).toBe(true);
    expect(runUsage.reconciliation.sumOfEntryEstimatedCostUsd).toBeCloseTo(0.3);
  });
});
