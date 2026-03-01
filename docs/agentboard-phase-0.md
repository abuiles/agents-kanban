# AgentBoard Phase 0

## What this build demonstrates

- Multi-repo kanban board
- Local-only task/repo/run persistence
- Dragging into Active starts a mock run lifecycle
- Mock logs, PR links, preview links, and artifact manifest
- Import/export board state as JSON

## UX checklist

1. Open the board with `All repos` selected.
2. Show repo badges on cards and the repo filter in the top bar.
3. Add a new repo with a baseline URL.
4. Create a task with prompt, acceptance criteria, and context links.
5. Move the task to `ACTIVE`.
6. Open the task detail panel and watch the status timeline advance.
7. Show mock PR and preview links appear.
8. Show mock evidence artifacts after the run reaches review.
9. Move the task to `DONE` manually.
10. Export the board JSON.
11. Refresh the page and confirm state persists.
12. Import the JSON to restore state.

## Code boundaries

- `src/ui/components/*`: rendering only
- `src/ui/store/*`: local persistence and snapshot ownership
- `src/ui/mock/*`: mock API and mock run simulator
