import { normalizeTenantId } from '../shared/tenant';

export type UsageLedgerCategory =
  | 'worker_request'
  | 'workflow_execution'
  | 'workflow_step'
  | 'workflow_duration_ms'
  | 'sandbox_runtime_ms'
  | 'operator_session_ms'
  | 'r2_storage_bytes'
  | 'r2_write_ops'
  | 'r2_read_ops'
  | 'artifact_download'
  | 'durable_object_request'
  | 'durable_object_storage_bytes';

export type UsageLedgerSource = 'worker' | 'workflow' | 'sandbox' | 'operator' | 'system';

export type UsageLedgerWriteInput = {
  tenantId: string;
  repoId?: string;
  taskId?: string;
  runId?: string;
  at?: string;
  category: UsageLedgerCategory;
  quantity: number;
  unit?: string;
  source: UsageLedgerSource;
  metadata?: Record<string, string | number | boolean>;
};

type UsageTableConfig = {
  table: string;
  columns: {
    id?: string;
    tenantId: string;
    repoId?: string;
    taskId?: string;
    runId?: string;
    at: string;
    category: string;
    quantity: string;
    unit?: string;
    source?: string;
    metadata?: string;
    rateVersion?: string;
    estimatedCostUsd?: string;
    unitRateUsd?: string;
  };
};

const TABLE_CANDIDATES = ['usage_ledger_entries', 'usage_ledger', 'tenant_usage_ledger', 'run_usage_ledger'] as const;
const RATE_VERSION = 'v1';

const RATE_CONFIG: Record<UsageLedgerCategory, { unit: string; usdRate: number }> = {
  worker_request: { unit: 'request', usdRate: 0.000002 },
  workflow_execution: { unit: 'execution', usdRate: 0.001 },
  workflow_step: { unit: 'step', usdRate: 0.0001 },
  workflow_duration_ms: { unit: 'ms', usdRate: 0.00000002 },
  sandbox_runtime_ms: { unit: 'ms', usdRate: 0.00000005 },
  operator_session_ms: { unit: 'ms', usdRate: 0.00000002 },
  r2_storage_bytes: { unit: 'byte', usdRate: 0.0000000000008 },
  r2_write_ops: { unit: 'op', usdRate: 0.0000045 },
  r2_read_ops: { unit: 'op', usdRate: 0.00000036 },
  artifact_download: { unit: 'download', usdRate: 0.000005 },
  durable_object_request: { unit: 'request', usdRate: 0.000002 },
  durable_object_storage_bytes: { unit: 'byte', usdRate: 0.0000000000006 }
};

function asD1Database(value: unknown): D1Database | undefined {
  if (value && typeof value === 'object' && 'prepare' in value && typeof (value as { prepare?: unknown }).prepare === 'function') {
    return value as D1Database;
  }
  return undefined;
}

function resolveUsageDatabase(env: Env): D1Database | undefined {
  const record = env as unknown as Record<string, unknown>;
  for (const preferred of ['USAGE_DB', 'TENANT_USAGE_DB', 'APP_DB', 'DB']) {
    const db = asD1Database(record[preferred]);
    if (db) {
      return db;
    }
  }
  for (const candidate of Object.values(record)) {
    const db = asD1Database(candidate);
    if (db) {
      return db;
    }
  }
  return undefined;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function selectColumn(columns: Set<string>, candidates: string[], required = false): string | undefined {
  const hit = candidates.find((candidate) => columns.has(candidate));
  if (!hit && required) {
    throw new Error(`Usage ledger schema is missing required columns (${candidates.join(' or ')}).`);
  }
  return hit;
}

async function resolveUsageTable(db: D1Database): Promise<UsageTableConfig | undefined> {
  const tables = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>();
  const tableNames = new Set((tables.results ?? []).map((row) => row.name));
  const table = TABLE_CANDIDATES.find((candidate) => tableNames.has(candidate));
  if (!table) {
    return undefined;
  }

  const pragmaRows = await db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all<{ name: string }>();
  const columnNames = new Set((pragmaRows.results ?? []).map((row) => row.name));
  const columns = {
    id: selectColumn(columnNames, ['id', 'entry_id']),
    tenantId: selectColumn(columnNames, ['tenant_id', 'tenantId'], true)!,
    repoId: selectColumn(columnNames, ['repo_id', 'repoId']),
    taskId: selectColumn(columnNames, ['task_id', 'taskId']),
    runId: selectColumn(columnNames, ['run_id', 'runId']),
    at: selectColumn(columnNames, ['at', 'created_at', 'recorded_at'], true)!,
    category: selectColumn(columnNames, ['category', 'usage_category'], true)!,
    quantity: selectColumn(columnNames, ['quantity', 'amount'], true)!,
    unit: selectColumn(columnNames, ['unit']),
    source: selectColumn(columnNames, ['source']),
    metadata: selectColumn(columnNames, ['metadata']),
    rateVersion: selectColumn(columnNames, ['rate_version', 'rateVersion']),
    estimatedCostUsd: selectColumn(columnNames, ['estimated_cost_usd', 'estimatedCostUsd', 'estimated_usd']),
    unitRateUsd: selectColumn(columnNames, ['unit_rate_usd', 'rate_usd', 'cost_rate_usd'])
  } satisfies UsageTableConfig['columns'];
  return { table, columns };
}

function toFiniteNumber(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function toJsonString(metadata: Record<string, string | number | boolean> | undefined): string | undefined {
  if (!metadata || !Object.keys(metadata).length) {
    return undefined;
  }
  return JSON.stringify(metadata);
}

export async function writeUsageLedgerEntries(env: Env, entries: UsageLedgerWriteInput[]): Promise<number> {
  if (!entries.length) {
    return 0;
  }

  const db = resolveUsageDatabase(env);
  if (!db) {
    return 0;
  }

  const usage = await resolveUsageTable(db);
  if (!usage) {
    return 0;
  }

  let written = 0;
  for (const entry of entries) {
    const at = entry.at ?? new Date().toISOString();
    const rate = RATE_CONFIG[entry.category];
    const rateVersion = RATE_VERSION;
    const unit = entry.unit ?? rate.unit;
    const estimatedCostUsd = toFiniteNumber(entry.quantity * rate.usdRate);
    const metadata = {
      ...(entry.metadata ?? {}),
      rateVersion
    };

    const columns: string[] = [];
    const values: unknown[] = [];
    const pushValue = (column: string | undefined, value: unknown) => {
      if (!column) {
        return;
      }
      columns.push(quoteIdentifier(column));
      values.push(value);
    };

    pushValue(usage.columns.id, crypto.randomUUID());
    pushValue(usage.columns.tenantId, normalizeTenantId(entry.tenantId));
    pushValue(usage.columns.repoId, entry.repoId ?? '');
    pushValue(usage.columns.taskId, entry.taskId ?? '');
    pushValue(usage.columns.runId, entry.runId ?? '');
    pushValue(usage.columns.at, at);
    pushValue(usage.columns.category, entry.category);
    pushValue(usage.columns.quantity, toFiniteNumber(entry.quantity));
    pushValue(usage.columns.unit, unit);
    pushValue(usage.columns.source, entry.source);
    pushValue(usage.columns.metadata, toJsonString(metadata));
    pushValue(usage.columns.rateVersion, rateVersion);
    pushValue(usage.columns.unitRateUsd, rate.usdRate);
    pushValue(usage.columns.estimatedCostUsd, estimatedCostUsd);

    if (!columns.length) {
      continue;
    }

    const placeholders = columns.map(() => '?').join(', ');
    await db
      .prepare(`INSERT INTO ${quoteIdentifier(usage.table)} (${columns.join(', ')}) VALUES (${placeholders})`)
      .bind(...values)
      .run();
    written += 1;
  }

  return written;
}

export async function writeUsageLedgerEntriesBestEffort(env: Env, entries: UsageLedgerWriteInput[]): Promise<void> {
  try {
    await writeUsageLedgerEntries(env, entries);
  } catch (error) {
    console.warn('Usage ledger write failed', { error });
  }
}
