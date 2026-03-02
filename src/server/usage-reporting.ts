import { badRequest, notFound, HttpError } from './http/errors';

type UsageGranularity = 'day' | 'month';

type UsageTotals = {
  runs: number;
  workflowExecutions: number;
  workflowSteps: number;
  workflowDurationMs: number;
  sandboxRuntimeMs: number;
  operatorSessionMs: number;
  r2StorageBytes: number;
  r2WriteOps: number;
  r2ReadOps: number;
  artifactDownloads: number;
  durableObjectRequests: number;
  durableObjectStorageBytes: number;
  workerRequests: number;
  estimatedCostUsd: number;
};

type UsageWindow = {
  from?: string;
  to?: string;
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

type RawD1Row = Record<string, unknown>;

const TABLE_CANDIDATES = ['usage_ledger_entries', 'usage_ledger', 'tenant_usage_ledger', 'run_usage_ledger'] as const;
const GRANULARITY_ALIASES: Record<string, UsageGranularity> = {
  day: 'day',
  daily: 'day',
  month: 'month',
  monthly: 'month'
};

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoDateBoundary(input: string, field: 'from' | 'to'): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw badRequest(`Invalid ${field} query parameter.`);
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw badRequest(`Invalid ${field} query parameter.`);
  }
  return date.toISOString();
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new HttpError(500, {
      code: 'INTERNAL_ERROR',
      message: `Unsafe SQL identifier: ${identifier}`,
      retryable: false
    });
  }
  return `"${identifier}"`;
}

function parseGranularity(url: URL): UsageGranularity {
  const raw = (url.searchParams.get('granularity') ?? url.searchParams.get('groupBy') ?? 'daily').toLowerCase();
  const granularity = GRANULARITY_ALIASES[raw];
  if (!granularity) {
    throw badRequest('Invalid granularity query parameter. Use daily|monthly or day|month.');
  }
  return granularity;
}

function parseWindow(url: URL): UsageWindow {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const parsedFrom = from ? toIsoDateBoundary(from, 'from') : undefined;
  const parsedTo = to ? toIsoDateBoundary(to, 'to') : undefined;
  if (parsedFrom && parsedTo && parsedFrom >= parsedTo) {
    throw badRequest('Invalid usage window. "from" must be before "to".');
  }
  return { from: parsedFrom, to: parsedTo };
}

function parseTenantId(url: URL): string {
  const tenantId = (url.searchParams.get('tenantId') ?? '').trim();
  if (!tenantId) {
    throw badRequest('Missing required tenantId query parameter.');
  }
  return tenantId;
}

function parsePagination(url: URL): { limit: number; offset: number } {
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');
  const limit = limitRaw ? Number(limitRaw) : 200;
  const offset = offsetRaw ? Number(offsetRaw) : 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw badRequest('Invalid limit query parameter. Expected integer in [1, 1000].');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw badRequest('Invalid offset query parameter. Expected non-negative integer.');
  }
  return { limit, offset };
}

function buildWhereClause(columns: UsageTableConfig['columns'], tenantId: string, window: UsageWindow) {
  const conditions: string[] = [];
  const bindings: Array<string> = [];
  conditions.push(`${quoteIdentifier(columns.tenantId)} = ?`);
  bindings.push(tenantId);
  if (window.from) {
    conditions.push(`${quoteIdentifier(columns.at)} >= ?`);
    bindings.push(window.from);
  }
  if (window.to) {
    conditions.push(`${quoteIdentifier(columns.at)} < ?`);
    bindings.push(window.to);
  }
  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    bindings
  };
}

function buildEstimatedCostSumExpr(columns: UsageTableConfig['columns']): string {
  if (columns.estimatedCostUsd) {
    return `COALESCE(SUM(${quoteIdentifier(columns.estimatedCostUsd)}), 0)`;
  }
  if (columns.unitRateUsd) {
    return `COALESCE(SUM(${quoteIdentifier(columns.quantity)} * ${quoteIdentifier(columns.unitRateUsd)}), 0)`;
  }
  return '0';
}

function buildEstimatedCostRowExpr(columns: UsageTableConfig['columns']): string {
  if (columns.estimatedCostUsd) {
    return `COALESCE(${quoteIdentifier(columns.estimatedCostUsd)}, 0)`;
  }
  if (columns.unitRateUsd) {
    return `COALESCE(${quoteIdentifier(columns.quantity)} * ${quoteIdentifier(columns.unitRateUsd)}, 0)`;
  }
  return '0';
}

function buildTotalsSelect(columns: UsageTableConfig['columns']) {
  const category = quoteIdentifier(columns.category);
  const quantity = quoteIdentifier(columns.quantity);
  const runsExpr = columns.runId
    ? `COUNT(DISTINCT CASE WHEN ${quoteIdentifier(columns.runId)} IS NOT NULL AND ${quoteIdentifier(columns.runId)} <> '' THEN ${quoteIdentifier(columns.runId)} END)`
    : '0';
  return `
    ${runsExpr} AS runs,
    COALESCE(SUM(CASE WHEN ${category} = 'workflow_execution' THEN ${quantity} ELSE 0 END), 0) AS workflowExecutions,
    COALESCE(SUM(CASE WHEN ${category} = 'workflow_step' THEN ${quantity} ELSE 0 END), 0) AS workflowSteps,
    COALESCE(SUM(CASE WHEN ${category} = 'workflow_duration_ms' THEN ${quantity} ELSE 0 END), 0) AS workflowDurationMs,
    COALESCE(SUM(CASE WHEN ${category} = 'sandbox_runtime_ms' THEN ${quantity} ELSE 0 END), 0) AS sandboxRuntimeMs,
    COALESCE(SUM(CASE WHEN ${category} = 'operator_session_ms' THEN ${quantity} ELSE 0 END), 0) AS operatorSessionMs,
    COALESCE(SUM(CASE WHEN ${category} = 'r2_storage_bytes' THEN ${quantity} ELSE 0 END), 0) AS r2StorageBytes,
    COALESCE(SUM(CASE WHEN ${category} = 'r2_write_ops' THEN ${quantity} ELSE 0 END), 0) AS r2WriteOps,
    COALESCE(SUM(CASE WHEN ${category} = 'r2_read_ops' THEN ${quantity} ELSE 0 END), 0) AS r2ReadOps,
    COALESCE(SUM(CASE WHEN ${category} = 'artifact_download' THEN ${quantity} ELSE 0 END), 0) AS artifactDownloads,
    COALESCE(SUM(CASE WHEN ${category} = 'durable_object_request' THEN ${quantity} ELSE 0 END), 0) AS durableObjectRequests,
    COALESCE(SUM(CASE WHEN ${category} = 'durable_object_storage_bytes' THEN ${quantity} ELSE 0 END), 0) AS durableObjectStorageBytes,
    COALESCE(SUM(CASE WHEN ${category} = 'worker_request' THEN ${quantity} ELSE 0 END), 0) AS workerRequests,
    ${buildEstimatedCostSumExpr(columns)} AS estimatedCostUsd
  `;
}

function mapTotals(row: RawD1Row | null | undefined): UsageTotals {
  return {
    runs: toNumber(row?.runs),
    workflowExecutions: toNumber(row?.workflowExecutions),
    workflowSteps: toNumber(row?.workflowSteps),
    workflowDurationMs: toNumber(row?.workflowDurationMs),
    sandboxRuntimeMs: toNumber(row?.sandboxRuntimeMs),
    operatorSessionMs: toNumber(row?.operatorSessionMs),
    r2StorageBytes: toNumber(row?.r2StorageBytes),
    r2WriteOps: toNumber(row?.r2WriteOps),
    r2ReadOps: toNumber(row?.r2ReadOps),
    artifactDownloads: toNumber(row?.artifactDownloads),
    durableObjectRequests: toNumber(row?.durableObjectRequests),
    durableObjectStorageBytes: toNumber(row?.durableObjectStorageBytes),
    workerRequests: toNumber(row?.workerRequests),
    estimatedCostUsd: toNumber(row?.estimatedCostUsd)
  };
}

function normalizeBucketStart(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value) {
    return new Date(0).toISOString();
  }
  return `${value}T00:00:00.000Z`;
}

function computeBucketEnd(start: string, granularity: UsageGranularity): string {
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) {
    return start;
  }
  if (granularity === 'day') {
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString();
  }
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString();
}

function parseMetadata(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (typeof raw !== 'string' || !raw.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const normalized: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        normalized[key] = value;
      }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function selectColumn(columns: Set<string>, candidates: string[], required = false): string | undefined {
  const hit = candidates.find((candidate) => columns.has(candidate));
  if (!hit && required) {
    throw new HttpError(500, {
      code: 'INTERNAL_ERROR',
      message: `Usage ledger schema is missing required columns (${candidates.join(' or ')}).`,
      retryable: false
    });
  }
  return hit;
}

function asD1Database(value: unknown): D1Database | undefined {
  if (value && typeof value === 'object' && 'prepare' in value && typeof (value as { prepare?: unknown }).prepare === 'function') {
    return value as D1Database;
  }
  return undefined;
}

function resolveUsageDatabase(env: Env): D1Database {
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
  throw new HttpError(503, {
    code: 'USAGE_DB_UNAVAILABLE',
    message: 'Usage reporting database binding is not configured.',
    retryable: true
  });
}

async function resolveUsageTable(db: D1Database): Promise<UsageTableConfig> {
  const tables = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>();
  const tableNames = new Set((tables.results ?? []).map((row) => row.name));
  const table = TABLE_CANDIDATES.find((candidate) => tableNames.has(candidate));
  if (!table) {
    throw notFound('Usage ledger table not found.');
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

export async function getTenantUsageSummary(url: URL, env: Env) {
  const tenantId = parseTenantId(url);
  const granularity = parseGranularity(url);
  const window = parseWindow(url);
  const db = resolveUsageDatabase(env);
  const usage = await resolveUsageTable(db);
  const totalsSelect = buildTotalsSelect(usage.columns);
  const { where, bindings } = buildWhereClause(usage.columns, tenantId, window);
  const fromTable = `FROM ${quoteIdentifier(usage.table)}`;

  const totals = await db.prepare(`SELECT ${totalsSelect} ${fromTable} ${where}`).bind(...bindings).first<RawD1Row>();

  const bucketExpr = granularity === 'day'
    ? `date(${quoteIdentifier(usage.columns.at)})`
    : `strftime('%Y-%m-01', ${quoteIdentifier(usage.columns.at)})`;
  const seriesRows = await db
    .prepare(`SELECT ${bucketExpr} AS bucketStart, ${totalsSelect} ${fromTable} ${where} GROUP BY bucketStart ORDER BY bucketStart ASC`)
    .bind(...bindings)
    .all<RawD1Row>();

  return {
    tenantId,
    granularity,
    windowStart: window.from,
    windowEnd: window.to,
    totals: mapTotals(totals),
    series: (seriesRows.results ?? []).map((row) => {
      const periodStart = normalizeBucketStart(row.bucketStart);
      return {
        periodStart,
        periodEnd: computeBucketEnd(periodStart, granularity),
        totals: mapTotals(row)
      };
    })
  };
}

export async function getTenantRunUsage(url: URL, env: Env) {
  const tenantId = parseTenantId(url);
  const window = parseWindow(url);
  const { limit, offset } = parsePagination(url);
  const db = resolveUsageDatabase(env);
  const usage = await resolveUsageTable(db);

  if (!usage.columns.runId) {
    return {
      tenantId,
      windowStart: window.from,
      windowEnd: window.to,
      pagination: { limit, offset, returned: 0 },
      runs: []
    };
  }

  const totalsSelect = buildTotalsSelect(usage.columns);
  const { where, bindings } = buildWhereClause(usage.columns, tenantId, window);
  const runCol = quoteIdentifier(usage.columns.runId);
  const fromTable = `FROM ${quoteIdentifier(usage.table)}`;
  const runRows = await db
    .prepare(`
      SELECT
        ${runCol} AS runId,
        ${usage.columns.repoId ? `MIN(${quoteIdentifier(usage.columns.repoId)})` : "''"} AS repoId,
        ${usage.columns.taskId ? `MIN(${quoteIdentifier(usage.columns.taskId)})` : "''"} AS taskId,
        MIN(${quoteIdentifier(usage.columns.at)}) AS firstSeenAt,
        MAX(${quoteIdentifier(usage.columns.at)}) AS lastSeenAt,
        ${totalsSelect}
      ${fromTable}
      ${where ? `${where} AND` : 'WHERE'} ${runCol} IS NOT NULL AND ${runCol} <> ''
      GROUP BY ${runCol}
      ORDER BY lastSeenAt DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...bindings, limit, offset)
    .all<RawD1Row>();

  return {
    tenantId,
    windowStart: window.from,
    windowEnd: window.to,
    pagination: { limit, offset, returned: (runRows.results ?? []).length },
    runs: (runRows.results ?? []).map((row) => ({
      runId: String(row.runId ?? ''),
      repoId: String(row.repoId ?? ''),
      taskId: String(row.taskId ?? ''),
      firstSeenAt: typeof row.firstSeenAt === 'string' ? row.firstSeenAt : undefined,
      lastSeenAt: typeof row.lastSeenAt === 'string' ? row.lastSeenAt : undefined,
      totals: mapTotals(row)
    }))
  };
}

export async function getRunUsage(runId: string, env: Env) {
  const trimmedRunId = runId.trim();
  if (!trimmedRunId) {
    throw badRequest('Invalid runId.');
  }

  const db = resolveUsageDatabase(env);
  const usage = await resolveUsageTable(db);
  if (!usage.columns.runId) {
    throw notFound(`Run usage for ${trimmedRunId} not found.`);
  }

  const runCol = quoteIdentifier(usage.columns.runId);
  const fromTable = `FROM ${quoteIdentifier(usage.table)}`;
  const totalsSelect = buildTotalsSelect(usage.columns);
  const totalsRow = await db
    .prepare(`
      SELECT
        MIN(${quoteIdentifier(usage.columns.tenantId)}) AS tenantId,
        ${usage.columns.repoId ? `MIN(${quoteIdentifier(usage.columns.repoId)})` : "''"} AS repoId,
        ${usage.columns.taskId ? `MIN(${quoteIdentifier(usage.columns.taskId)})` : "''"} AS taskId,
        MIN(${quoteIdentifier(usage.columns.at)}) AS firstSeenAt,
        MAX(${quoteIdentifier(usage.columns.at)}) AS lastSeenAt,
        ${totalsSelect}
      ${fromTable}
      WHERE ${runCol} = ?
    `)
    .bind(trimmedRunId)
    .first<RawD1Row>();

  const rowCount = await db
    .prepare(`SELECT COUNT(*) AS count ${fromTable} WHERE ${runCol} = ?`)
    .bind(trimmedRunId)
    .first<{ count: number }>();

  if (!rowCount || toNumber(rowCount.count) < 1) {
    throw notFound(`Run usage for ${trimmedRunId} not found.`, { runId: trimmedRunId });
  }

  const metadataExpr = usage.columns.metadata ? quoteIdentifier(usage.columns.metadata) : 'NULL';
  const entries = await db
    .prepare(`
      SELECT
        ${usage.columns.id ? quoteIdentifier(usage.columns.id) : "''"} AS id,
        ${quoteIdentifier(usage.columns.tenantId)} AS tenantId,
        ${usage.columns.repoId ? quoteIdentifier(usage.columns.repoId) : "''"} AS repoId,
        ${usage.columns.taskId ? quoteIdentifier(usage.columns.taskId) : "''"} AS taskId,
        ${runCol} AS runId,
        ${quoteIdentifier(usage.columns.at)} AS at,
        ${quoteIdentifier(usage.columns.category)} AS category,
        ${quoteIdentifier(usage.columns.quantity)} AS quantity,
        ${usage.columns.unit ? quoteIdentifier(usage.columns.unit) : "''"} AS unit,
        ${usage.columns.source ? quoteIdentifier(usage.columns.source) : "''"} AS source,
        ${usage.columns.rateVersion ? quoteIdentifier(usage.columns.rateVersion) : "''"} AS rateVersion,
        ${buildEstimatedCostRowExpr(usage.columns)} AS estimatedCostUsd,
        ${metadataExpr} AS metadata
      ${fromTable}
      WHERE ${runCol} = ?
      ORDER BY ${quoteIdentifier(usage.columns.at)} ASC
    `)
    .bind(trimmedRunId)
    .all<RawD1Row>();

  const rawEntries = (entries.results ?? []).map((row) => ({
    id: String(row.id ?? ''),
    tenantId: String(row.tenantId ?? ''),
    repoId: String(row.repoId ?? ''),
    taskId: String(row.taskId ?? ''),
    runId: String(row.runId ?? ''),
    at: String(row.at ?? ''),
    category: String(row.category ?? ''),
    quantity: toNumber(row.quantity),
    unit: String(row.unit ?? ''),
    source: String(row.source ?? ''),
    rateVersion: row.rateVersion ? String(row.rateVersion) : undefined,
    estimatedCostUsd: toNumber(row.estimatedCostUsd),
    metadata: parseMetadata(row.metadata)
  }));
  const rawEstimatedCostUsd = rawEntries.reduce((sum, entry) => sum + entry.estimatedCostUsd, 0);
  const mappedTotals = mapTotals(totalsRow);
  const reconciles = Math.abs(rawEstimatedCostUsd - mappedTotals.estimatedCostUsd) < 1e-9;

  return {
    runId: trimmedRunId,
    tenantId: String(totalsRow?.tenantId ?? rawEntries[0]?.tenantId ?? ''),
    repoId: String(totalsRow?.repoId ?? rawEntries[0]?.repoId ?? ''),
    taskId: String(totalsRow?.taskId ?? rawEntries[0]?.taskId ?? ''),
    firstSeenAt: typeof totalsRow?.firstSeenAt === 'string' ? totalsRow.firstSeenAt : undefined,
    lastSeenAt: typeof totalsRow?.lastSeenAt === 'string' ? totalsRow.lastSeenAt : undefined,
    totals: mappedTotals,
    entries: rawEntries,
    reconciliation: {
      ledgerEntryCount: rawEntries.length,
      sumOfEntryEstimatedCostUsd: rawEstimatedCostUsd,
      totalsEstimatedCostUsd: mappedTotals.estimatedCostUsd,
      reconciles
    }
  };
}
