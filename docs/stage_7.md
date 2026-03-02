# AgentBoard Stage 7 (Scale)

## Goal

Stage 7 makes AgentBoard behave coherently across many repos and concurrent runs.

## Scope

In scope:

- per-repo concurrency limits
- global concurrency limits
- visible queued state and reason codes
- scheduling classes or priorities
- backpressure behavior when capacity is exhausted

Out of scope:

- broad policy enforcement
- credential hardening
- deeper security controls

## Target outcomes

By the end of Stage 7, an operator should be able to:

- understand why a run is waiting
- see which runs are queued vs running
- prevent one noisy repo from dominating capacity
- reason about concurrency behavior from the product itself

## Additive model

Recommended type:

```ts
type RunQueueState = {
  state: 'queued' | 'running' | 'blocked';
  reason?: string;
  priorityClass?: 'default' | 'interactive' | 'bulk';
};
```

Rules:

- queue state must be visible in API and UI
- per-repo and global limits must both be enforced
- backpressure behavior should produce reason codes instead of silent waiting

## API / projection additions

Add queue metadata to:

- run records
- board projection
- run event stream where relevant

Optional internal implementation choices may include Cloudflare Queues, but the product contract should stay coherent regardless of transport choice.

## UI expectations

Add:

- queued status treatment distinct from active running states
- visible queue reason in board cards and detail panel
- optional priority class display if supported

## Testing plan

Add coverage for:

- per-repo concurrency enforcement
- global concurrency enforcement
- queue reason visibility
- fairness behavior across multiple repos

## Acceptance criteria

Stage 7 is complete when:

- queueing and concurrency are visible in the product
- limits are enforced consistently
- waiting runs expose a clear reason
- multi-repo usage remains understandable to operators

## Recommended build order

1. Add Stage 7 docs and lock queue semantics.
2. Add queue state metadata to run models and board projection.
3. Add per-repo and global concurrency enforcement.
4. Add queued reason/status UI.
5. Validate behavior with overlapping runs across multiple repos.
