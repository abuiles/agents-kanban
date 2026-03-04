# AgentsKanban Run Context

runId: run_repo_abuiles_agents_kanban_mmc6uzihy649
taskId: task_repo_abuiles_agents_kanban_fzuugonb
repoId: repo_abuiles_agents_kanban
repoSlug: abuiles/agents-kanban
branchName: agent/task_repo_abuiles_agents_kanban_fzuugonb/run_repo_abuiles_agents_kanban_mmc6uzihy649
checkpointSequence: 001
checkpointPhase: codex
contextNotesPath: .agentskanban/context/run-context.md

Task:
- title: C5 - Checkpoint APIs and UI Surfaces
- prompt: Implement C5 from docs/plans/current/p8-checkpoint-recovery-and-context-notes.md.\n\nHard gates:\n- Start from main.\n- Do not begin until C4 is merged to main.\n\nRequired outcomes:\n1. Add GET /api/runs/:runId/checkpoints.\n2. Add GET /api/tasks/:taskId/checkpoints?latest=true.\n3. Add UI checkpoint list for run/task detail surfaces.\n4. Show resumed-from checkpoint indicators.\n5. Add tests for endpoint contracts and UI states.\n\nAdditional requirement:\n- Before pushing the branch, run `yarn typecheck` and fix all issues.

Acceptance Criteria:
- Operators can list checkpoints for runs and tasks.
- UI clearly shows checkpoint and resumed-from metadata.
- API responses are deterministic and backward compatible.

Notes:
- C chain is blocked on completion of current active batch: T6 + AR6 + S6 review-ready.

Links:
- P8 Plan: https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p8-checkpoint-recovery-and-context-notes.md
- P8 Task Pack: https://github.com/abuiles/agents-kanban/blob/main/docs/plans/current/p8-agentskanban-task-payloads.md
- Run Orchestrator: https://github.com/abuiles/agents-kanban/blob/main/src/server/run-orchestrator.ts
