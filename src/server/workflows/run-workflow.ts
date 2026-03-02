import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { RunJobParams } from '../shared/real-run';
import { executeRunJob } from '../run-orchestrator';

export class RunWorkflow extends WorkflowEntrypoint<Env, RunJobParams> {
  async run(event: Readonly<{ payload: Readonly<RunJobParams> }>, step: { sleep(name: string, duration: number | `${number} ${string}`): Promise<void> }) {
    await executeRunJob(this.env, event.payload, (name, duration) => step.sleep(name, duration));
    return { ok: true, runId: event.payload.runId, mode: event.payload.mode };
  }
}
