# Dashboard Spec

## Purpose

`AgentsKanban` is a multi-repo operator dashboard for creating tasks, starting agent runs, monitoring execution, handling review loops, and inspecting artifacts, logs, and operator takeover state.

This document is a living product and UX spec. It captures both:

- the current dashboard behavior and feature set
- the current redesign direction for reducing overload and improving task-state clarity

## Primary Objects

### Repo

A repo is the execution boundary for tasks and runs. Repo configuration includes:

- SCM metadata
- baseline URL
- executor and model defaults
- preview and evidence configuration
- review playbook selection
- sentinel orchestration settings
- checkpoint configuration

### Task

A task is the planning and board unit. It owns:

- title and description
- task prompt and acceptance criteria
- task context links and notes
- dependency metadata
- board lane status
- archive state
- repo association

### Run

A run is the execution unit for a task. A task can have multiple runs over time. A run owns:

- execution status
- branch, PR, preview, and evidence data
- review execution and findings
- logs, commands, events, errors, checkpoints, and artifacts

## Dashboard Surfaces

### Control Surface

The top control area is the global operator entry point. It currently supports:

- repo filtering
- task creation
- repo add and repo settings
- review playbook management
- export

The redesign groups these actions by intent:

- `Primary flow`: create task, add repo, repo settings
- `Configuration`: review playbooks
- `Data`: export

### Access Tools Strip

The authenticated utilities above the board are now collapsed by default into a compact strip that shows:

- signed-in identity
- role
- invite count for owners
- API token count

Expanded access tools reveal invite management and personal API token management without competing with the board for first-screen attention.

### Summary Row

The summary row is the board orientation layer. It now surfaces:

- repo count
- visible task count after filters
- running task count
- review-complete count
- attention-needed count
- archive visibility control

It also owns board focus filters:

- `All tasks`
- `Running`
- `Review done`
- `Attention`

### Board

The board is the main operational view. It renders the core task lanes:

- `INBOX`
- `READY`
- `ACTIVE`
- `REVIEW`
- `DONE`
- `FAILED`

Each card now emphasizes:

- repo
- live run state
- review state
- recency

Running tasks are visually distinguished with a stronger cyan treatment and an animated pulse indicator.

### Archive Shelf

Archived tasks are hidden from the main board by default but remain available in a collapsible archive shelf.

Archive behavior:

- archive does not delete a task
- archive preserves task detail, run history, and selection
- archived tasks can be restored back to the active board

### Detail Panel

The right panel is the task cockpit. It contains:

- top-level task metadata
- archive and restore action
- current state summary
- latest run actions
- run metadata
- terminal access
- event timeline
- artifacts
- task brief
- logs
- dependency state
- checkpoint state

The redesign adds an explicit current-state summary with:

- board lane
- run state
- review state
- last updated time

It also adds a dedicated review summary block inside the latest run section.

## Core Workflows

### Task Creation

Operators create a task from the control surface. A task starts in `INBOX` unless explicitly created elsewhere.

### Task Activation

Dragging or moving a task to `ACTIVE` starts a real run. Once a run is in progress, the UI prevents moving the task away from `ACTIVE` until the run reaches a terminal state.

### Review Cycle

The review lifecycle uses both task status and run-level review metadata.

Important review states:

- review not started
- review running
- review open
- preview pending
- review complete with no open findings
- review complete with open findings
- review failed

The redesign makes review completion explicit on both the card and the detail panel.

### Retry and Recovery

From the detail panel, operators can:

- retry a run
- re-run review
- request changes
- retry preview discovery
- retry evidence
- cancel a run
- open or take over a terminal session

### Archive and Restore

Archive is now a first-class task action.

Rules:

- archived tasks are removed from the main board lanes
- archived tasks remain in export/import and task detail
- archived tasks appear in the archive shelf when revealed
- restore returns the task to its original lane state

Bulk archive is supported in two ways:

- lane-level archive for `DONE` and `FAILED`
- multi-select mode with `Archive selected`

## Current Feature Map

### Board-Level Features

- repo filtering
- drag-and-drop lane movement
- live task selection
- board snapshot sync
- notice banner feedback

### Task-Level Features

- task editing
- task dependency display
- archive and restore
- run history inspection

### Run-Level Features

- latest run status
- branch and PR visibility
- preview and artifact visibility
- review execution visibility
- retry and cancellation actions
- operator takeover state
- checkpoint summary

### Supporting Modals

- add repo
- edit repo
- create task
- edit task
- review playbook manager
- request changes form
- terminal modal

### Repo Settings Modal

Repo configuration is now grouped into explicit sections so operators can scan by intent instead of parsing one uninterrupted form:

- `Repo basics`
- `Preview and evidence`
- `Review defaults`
- `Task execution defaults`
- `Auth and commit policy`
- `Sentinel`

This modal is used for both `Add repo` and `Repo settings`. The structure is intentionally consistent so creating and maintaining a repo share the same mental model.

### Task Creation Modal

Task creation is now grouped into four sections:

- `Task basics`
- `Requirements and context`
- `Automation and review`
- `Execution defaults`

This reduces overload by separating task definition, supporting context, automation overrides, and executor configuration.

## UX Problems That Motivated The Redesign

### Running State Was Too Hard To See

Before the redesign, the board mainly exposed raw lane state and lightly styled run labels. Operators had to read small status text to figure out whether a task was actually active.

### Review Completion Was Too Hard To See

Review completion existed in run metadata, but it was not promoted into a strong visual state on the card or in the detail header.

### Completed Work Created Noise

Historical tasks stayed on the board indefinitely, which made active work harder to scan.

### The Top-Level Command Surface Felt Flat

The header exposed important actions, but everything had similar visual weight. That made it harder to separate everyday operations from lower-frequency configuration and data actions.

## Redesign Principles

### 1. Separate Board State From Execution State

Board lane is useful, but operators need a second axis:

- `where the task is on the board`
- `what the latest run is doing right now`

### 2. Treat Review As A First-Class State

Review should never be inferred from PR numbers or deep logs alone. The UI should always answer:

- has review started?
- is it still running?
- did it complete?
- did it find issues?

### 3. Keep History Without Keeping Noise

Archive is the mechanism for preserving history while keeping the main board focused on live work.

### 4. Keep The Primary Path Obvious

The default operator actions should read as:

- create task
- add or edit repo
- focus the board
- inspect or intervene on a task

## Implemented Redesign Direction

### Running Clarity

- cards now show stronger live run labels
- live tasks get a pulse indicator
- running tasks are surfaced in summary metrics and filters

### Review Clarity

- cards now show a dedicated review badge
- detail panel now shows a review summary block
- review completion and findings are visible without opening logs

### Archive Support

- tasks now support an archive flag
- archive and restore are available in the detail panel
- archived tasks are hidden from the board but available in a dedicated shelf

### Reduced Overload

- top controls are grouped by intent
- board focus filters are explicit
- archive is moved out of the primary board lanes

## Future Design Space

This spec is meant to support future UI exploration without re-discovering product behavior. Likely next design directions:

- multi-density board views
- a stronger “live operations” mode
- compact and expanded task card variants
- timeline-first task detail layouts
- repo-level and task-level saved views
- archive policies and auto-archive rules
