#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';

const PASSWORD_HASH_SCHEME = 'pbkdf2_sha256';
const PASSWORD_HASH_ITERATIONS = 210_000;
const PASSWORD_SALT_BYTES = 16;

type OwnerInput = {
  email: string;
  password: string;
  displayName?: string;
  externalId?: string;
};

type BootstrapInput = {
  tenant: {
    externalId: string;
    slug: string;
    name: string;
    domain?: string;
    seatLimit?: number;
    createdByUserId?: string;
  };
  owners: OwnerInput[];
};

type CliOptions = {
  inputPath: string;
  dbBinding: string;
  mode: 'local' | 'remote';
  config?: string;
  env?: string;
  persistTo?: string;
  dryRun: boolean;
};

function printUsage(): void {
  process.stdout.write(
    [
      'Usage:',
      '  npm run bootstrap:single-tenant -- --input <path> [--local|--remote] [--db TENANT_DB] [--config wrangler.jsonc] [--env <name>] [--persist-to <dir>] [--dry-run]',
      '',
      'Example:',
      '  npm run bootstrap:single-tenant -- --input ./scripts/bootstrap-single-tenant.example.json --local'
    ].join('\n') + '\n'
  );
}

function parseArgs(argv: string[]): CliOptions {
  let inputPath = '';
  let dbBinding = 'TENANT_DB';
  let mode: 'local' | 'remote' = 'local';
  let config: string | undefined;
  let env: string | undefined;
  let persistTo: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--input') {
      inputPath = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg === '--db') {
      dbBinding = argv[i + 1] ?? dbBinding;
      i += 1;
      continue;
    }
    if (arg === '--config') {
      config = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--env') {
      env = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--persist-to') {
      persistTo = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--local') {
      mode = 'local';
      continue;
    }
    if (arg === '--remote') {
      mode = 'remote';
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!inputPath) {
    throw new Error('Missing required --input <path> argument.');
  }

  return {
    inputPath: resolve(inputPath),
    dbBinding,
    mode,
    config,
    env,
    persistTo,
    dryRun
  };
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${field}: expected non-empty string.`);
  }
  return value.trim();
}

function normalizeEmail(value: unknown, field: string): string {
  const email = assertNonEmptyString(value, field).toLowerCase();
  if (!email.includes('@')) {
    throw new Error(`Invalid ${field}: expected an email address.`);
  }
  return email;
}

function parseInput(raw: string): BootstrapInput {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const tenantRaw = (parsed.tenant ?? {}) as Record<string, unknown>;
  const ownersRaw = parsed.owners;

  if (!Array.isArray(ownersRaw) || ownersRaw.length === 0) {
    throw new Error('Invalid owners: expected a non-empty owners array.');
  }

  const seatLimitRaw = tenantRaw.seatLimit;
  const seatLimit = seatLimitRaw === undefined ? 100 : Number(seatLimitRaw);
  if (!Number.isInteger(seatLimit) || seatLimit <= 0) {
    throw new Error('Invalid tenant.seatLimit: expected a positive integer.');
  }

  const owners = ownersRaw.map((owner, index) => {
    const record = owner as Record<string, unknown>;
    return {
      email: normalizeEmail(record.email, `owners[${index}].email`),
      password: assertNonEmptyString(record.password, `owners[${index}].password`),
      displayName: record.displayName === undefined ? undefined : assertNonEmptyString(record.displayName, `owners[${index}].displayName`),
      externalId: record.externalId === undefined ? undefined : assertNonEmptyString(record.externalId, `owners[${index}].externalId`)
    } satisfies OwnerInput;
  });

  const duplicateOwners = new Set<string>();
  for (const owner of owners) {
    if (duplicateOwners.has(owner.email)) {
      throw new Error(`Duplicate owner email in input: ${owner.email}`);
    }
    duplicateOwners.add(owner.email);
  }

  return {
    tenant: {
      externalId: assertNonEmptyString(tenantRaw.externalId, 'tenant.externalId'),
      slug: assertNonEmptyString(tenantRaw.slug, 'tenant.slug'),
      name: assertNonEmptyString(tenantRaw.name, 'tenant.name'),
      domain: tenantRaw.domain === undefined ? undefined : assertNonEmptyString(tenantRaw.domain, 'tenant.domain'),
      seatLimit,
      createdByUserId: tenantRaw.createdByUserId === undefined ? 'system' : assertNonEmptyString(tenantRaw.createdByUserId, 'tenant.createdByUserId')
    },
    owners
  };
}

function sqlString(value: string | undefined | null): string {
  if (value === undefined || value === null) {
    return 'NULL';
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function ownerExternalId(owner: OwnerInput): string {
  if (owner.externalId) {
    return owner.externalId;
  }
  return `owner_${createHash('sha256').update(owner.email).digest('hex').slice(0, 24)}`;
}

function passwordHash(password: string): string {
  const saltHex = randomBytes(PASSWORD_SALT_BYTES).toString('hex');
  const digestHex = pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), PASSWORD_HASH_ITERATIONS, 32, 'sha256').toString('hex');
  return `${PASSWORD_HASH_SCHEME}$${PASSWORD_HASH_ITERATIONS}$${saltHex}$${digestHex}`;
}

function buildSql(input: BootstrapInput): string {
  const now = new Date().toISOString();
  const statements: string[] = [];
  statements.push('BEGIN TRANSACTION;');
  statements.push(`
INSERT INTO app_tenant_config (id, external_id, slug, name, status, domain, created_by_user_id, seat_limit, created_at, updated_at)
VALUES (
  1,
  ${sqlString(input.tenant.externalId)},
  ${sqlString(input.tenant.slug)},
  ${sqlString(input.tenant.name)},
  'active',
  ${sqlString(input.tenant.domain)},
  ${sqlString(input.tenant.createdByUserId ?? 'system')},
  ${input.tenant.seatLimit ?? 100},
  ${sqlString(now)},
  ${sqlString(now)}
)
ON CONFLICT(id) DO UPDATE SET
  external_id = excluded.external_id,
  slug = excluded.slug,
  name = excluded.name,
  status = 'active',
  domain = excluded.domain,
  created_by_user_id = excluded.created_by_user_id,
  seat_limit = excluded.seat_limit,
  updated_at = excluded.updated_at;
`.trim());

  for (const owner of input.owners) {
    statements.push(`
INSERT INTO users (external_id, email, display_name, role, password_hash, created_at, updated_at)
VALUES (
  ${sqlString(ownerExternalId(owner))},
  ${sqlString(owner.email)},
  ${sqlString(owner.displayName)},
  'owner',
  ${sqlString(passwordHash(owner.password))},
  ${sqlString(now)},
  ${sqlString(now)}
)
ON CONFLICT(email) DO UPDATE SET
  display_name = excluded.display_name,
  role = 'owner',
  password_hash = excluded.password_hash,
  updated_at = excluded.updated_at;
`.trim());
  }

  statements.push('COMMIT;');
  return `${statements.join('\n\n')}\n`;
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rawInput = await readFile(options.inputPath, 'utf8');
  const parsedInput = parseInput(rawInput);
  const sql = buildSql(parsedInput);

  if (options.dryRun) {
    process.stdout.write(sql);
    return;
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'bootstrap-single-tenant-'));
  const sqlPath = join(tempDir, 'bootstrap.sql');

  try {
    await writeFile(sqlPath, sql, 'utf8');

    const args = ['wrangler', 'd1', 'execute', options.dbBinding, '--file', sqlPath, '--yes', options.mode === 'remote' ? '--remote' : '--local'];
    if (options.config) {
      args.push('--config', options.config);
    }
    if (options.env) {
      args.push('--env', options.env);
    }
    if (options.persistTo) {
      args.push('--persist-to', options.persistTo);
    }

    process.stdout.write(`Applying single-tenant bootstrap to ${options.dbBinding} (${options.mode}) using ${options.inputPath}\n`);
    const result = spawnSync('npx', args, { stdio: 'inherit' });

    if (result.error) {
      throw result.error;
    }
    if (typeof result.status === 'number' && result.status !== 0) {
      throw new Error(`wrangler d1 execute exited with status ${result.status}.`);
    }

    process.stdout.write(`Bootstrap complete. Tenant '${parsedInput.tenant.slug}' and ${parsedInput.owners.length} owner account(s) are upserted.\n`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`bootstrap-single-tenant failed: ${message}\n`);
  process.exit(1);
});
