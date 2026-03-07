import type { Repo, RunCommandPhase } from '../../ui/domain/types';
import { buildRunLog } from '../shared/real-run';
import { redactSensitiveText } from '../security/redaction';
import type { LlmRuntimeContext } from './adapter';

type RuntimeEnvWithBundles = Env & {
  RUN_ARTIFACTS?: R2Bucket;
  AGENTS_BUNDLE_R2_KEY?: string;
};

type LogPhase = Exclude<RunCommandPhase, 'operator'>;

export async function restoreAgentsHomeBundle(
  context: LlmRuntimeContext,
  repo: Repo,
  phase: LogPhase = 'bootstrap'
) {
  const env = context.env as RuntimeEnvWithBundles;
  const repoBundleKey = repo.agentsBundleR2Key?.trim();
  const bundleKey = repoBundleKey || env.AGENTS_BUNDLE_R2_KEY?.trim();
  if (!bundleKey) {
    await context.repoBoard.appendRunLogs(context.runId, [
      buildRunLog(context.runId, 'No .agents bundle configured. Skipping .agents home injection.', phase)
    ]);
    return;
  }
  if (!env.RUN_ARTIFACTS) {
    await context.repoBoard.appendRunLogs(context.runId, [
      buildRunLog(context.runId, 'RUN_ARTIFACTS binding is not configured; skipping .agents home injection.', phase, 'error')
    ]);
    return;
  }

  try {
    const object = await env.RUN_ARTIFACTS.get(bundleKey);
    if (!object) {
      await context.repoBoard.appendRunLogs(context.runId, [
        buildRunLog(context.runId, `.agents bundle ${bundleKey} not found in R2. Continuing without .agents home injection.`, phase, 'error')
      ]);
      return;
    }

    const archiveBase64 = bytesToBase64(await object.arrayBuffer());
    await context.sandbox.writeFile('/workspace/agents-home.tgz.b64', archiveBase64);
    const restoreResult = await context.sandbox.exec(
      `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
base64 -d /workspace/agents-home.tgz.b64 > /workspace/agents-home.tgz
mkdir -p "$HOME"
tar -xzf /workspace/agents-home.tgz -C "$HOME"
test -d "$HOME/.agents"
ls -1 "$HOME/.agents" | sort | head -n 40
`)}`
    );
    await appendCommandLogs(context, phase, restoreResult.stdout, restoreResult.stderr);
    if (!restoreResult.success) {
      await context.repoBoard.appendRunLogs(context.runId, [
        buildRunLog(context.runId, `.agents bundle restore failed for ${bundleKey}. Continuing without .agents home injection.`, phase, 'error')
      ]);
      return;
    }

    await context.repoBoard.appendRunLogs(context.runId, [
      buildRunLog(context.runId, `.agents home bundle restored from ${bundleKey}.`, phase)
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.repoBoard.appendRunLogs(context.runId, [
      buildRunLog(context.runId, `Failed to restore .agents bundle: ${message}. Continuing without .agents home injection.`, phase, 'error')
    ]);
  }
}

async function appendCommandLogs(
  context: Pick<LlmRuntimeContext, 'repoBoard' | 'runId'>,
  phase: LogPhase,
  stdout?: string,
  stderr?: string
) {
  const logs = [
    ...(stdout ? stdout.split(/\r?\n/).filter(Boolean).map((line) => buildRunLog(context.runId, redactSensitiveText(line), phase, 'info')) : []),
    ...(stderr ? stderr.split(/\r?\n/).filter(Boolean).map((line) => buildRunLog(context.runId, redactSensitiveText(line), phase, 'error')) : [])
  ];
  if (logs.length) {
    await context.repoBoard.appendRunLogs(context.runId, logs);
  }
}

function bytesToBase64(buffer: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
