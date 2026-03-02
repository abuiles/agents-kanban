# API Prompt

Use this app through its same-origin API.

Base URL:

```text
<PREVIEW_URL>
```

API base:

```text
<PREVIEW_URL>/api
```

Your job:

- inspect the current board state
- understand repos, tasks, runs, logs, and artifacts
- create or update tasks if needed
- start and retry runs when appropriate
- use logs and artifact metadata to explain what happened

Recommended flow:

1. Call `GET /api/board?repoId=all`
2. Identify the target repo, task, and latest run
3. If needed, create a task with `POST /api/tasks`
4. Start execution with `POST /api/tasks/:taskId/run`
5. Poll `GET /api/runs/:runId`
6. Read logs with `GET /api/runs/:runId/logs`
7. Inspect artifacts with `GET /api/runs/:runId/artifacts`

Important action endpoints:

- `POST /api/runs/:runId/retry`
- `POST /api/runs/:runId/preview`
- `POST /api/runs/:runId/evidence`

Important notes:

- all write endpoints use JSON
- action endpoints usually accept an empty JSON body: `{}`
- run status, preview status, and evidence status are separate
- the best debugging signal is usually in `logs`
- the best full-state snapshot is `GET /api/board?repoId=all`

Useful task payload:

```json
{
  "repoId": "repo_abuiles_minions_demo",
  "title": "Build simple snake game on index",
  "description": "Create a dummy and simple snake game on the index page.",
  "taskPrompt": "Create a dummy and simple snake game on the index page. Keep it lightweight and easy to review.",
  "acceptanceCriteria": [
    "A playable snake game is visible on the index page.",
    "The implementation is intentionally simple.",
    "No unnecessary dependencies are introduced."
  ],
  "context": {
    "links": [],
    "notes": "Keep this intentionally small."
  },
  "status": "INBOX",
  "codexModel": "gpt-5.1-codex-mini",
  "codexReasoningEffort": "medium"
}
```

When reporting back:

- mention the `taskId`
- mention the `runId`
- mention the latest `status`
- include the key log lines
- include `prUrl` and `previewUrl` if present
