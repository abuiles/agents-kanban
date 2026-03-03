#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Optional

API_TIMEOUT_SECONDS = 15
TASK_STATUS_ACTIVE = "ACTIVE"
TASK_STATUS_REVIEW = "REVIEW"
TASK_STATUS_DONE = "DONE"
TASK_STATUS_INBOX = "INBOX"
TASK_STATUS_READY = "READY"
TASK_STATUSES_TO_START = {TASK_STATUS_INBOX, TASK_STATUS_READY}
MERGE_FLAGS = {
    "squash": "--squash",
    "merge": "--merge",
    "ff-only": "--ff-only",
    "rebase": "--rebase",
}

# Conservative merge states from CLI behaviour in repo scripts.
ALLOWED_MERGE_STATES = {"OPEN", "OPENED"}
MAYBE_MERGEABLE_STATES = {"CLEAN", "HAS_HOOKS"}


class KanbanApiClient:
    def __init__(self, base_url: str, headers: Optional[dict[str, str]] = None, timeout: int = API_TIMEOUT_SECONDS):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.headers = {"accept": "application/json"}
        if headers:
            self.headers.update({k: v for k, v in headers.items() if v})

    def _url(self, path: str) -> str:
        if not path.startswith("/"):
            path = f"/{path}"
        return f"{self.base_url}{path}"

    def request(self, method: str, path: str, payload: Optional[dict] = None) -> dict:
        req = urllib.request.Request(
            self._url(path),
            method=method,
            headers={**self.headers, "content-type": "application/json"} if payload else self.headers,
            data=None if payload is None else json.dumps(payload).encode("utf-8"),
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                if response.status == 204:
                    return {}
                body = response.read().decode("utf-8")
                if not body.strip():
                    return {}
                return json.loads(body)
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="ignore") if error.fp else ""
            raise RuntimeError(f"HTTP {error.code} {path}: {body or error.reason}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"Request failed for {path}: {error}") from error

    def get_board(self, repo_id: str = "all") -> dict:
        return self.request("GET", f"/api/board?repoId={urllib.parse.quote_plus(repo_id)}")

    def get_run(self, run_id: str) -> dict:
        return self.request("GET", f"/api/runs/{urllib.parse.quote_plus(run_id)}")

    def patch_task_status(self, task_id: str, status: str) -> dict:
        return self.request("PATCH", f"/api/tasks/{urllib.parse.quote_plus(task_id)}", {"status": status})

    def start_task(self, task_id: str) -> dict:
        return self.request("POST", f"/api/tasks/{urllib.parse.quote_plus(task_id)}/run", {})


class GhClient:
    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run

    @staticmethod
    def _run(cmd: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
        )

    def can_call(self) -> bool:
        if self.dry_run:
            return True
        return self._run(["gh", "--version"]).returncode == 0

    def pr_view(self, repo: str, number: int) -> tuple[str, Optional[str], str]:
        """Return (state, mergeStateStatus, error_reason)."""
        if self.dry_run:
            return "DRYRUN", None, ""

        proc = self._run(["gh", "pr", "view", str(number), "-R", repo, "--json", "state,mergeStateStatus"])
        if proc.returncode != 0:
            return "", None, proc.stderr.strip() or proc.stdout.strip() or "gh pr view failed"

        try:
            payload = json.loads(proc.stdout)
            return payload.get("state", ""), payload.get("mergeStateStatus"), ""
        except json.JSONDecodeError as error:
            return "", None, f"Invalid gh output: {error}"

    def pr_merge(self, repo: str, number: int, strategy: str) -> subprocess.CompletedProcess:
        if self.dry_run:
            return subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")

        return self._run([
            "gh",
            "pr",
            "merge",
            str(number),
            "-R",
            repo,
            "--admin",
            "--delete-branch",
            MERGE_FLAGS[strategy],
        ])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "LLM-friendly AgentsKanban sweep for localhost:5173."
            " Default is plan mode (no mutations)."
        )
    )
    parser.add_argument("--api-base", default="http://localhost:5173", help="API base URL")
    parser.add_argument("--mode", choices=["plan", "run"], default="plan", help="plan: analyze only, run: apply changes")
    parser.add_argument("--execute", action="store_true", help="Alias for --mode run")
    parser.add_argument("--max-active", type=int, default=3, help="Maximum number of ACTIVE tasks")
    parser.add_argument("--single-repo", default=None, help="Limit to one repoId")
    parser.add_argument("--merge-strategy", choices=sorted(MERGE_FLAGS), default="squash", help="gh pr merge strategy")
    parser.add_argument("--dry-run", action="store_true", help="Show would-be changes without applying mutations")
    parser.add_argument("--json", action="store_true", default=False, help="Pretty printed JSON")
    parser.add_argument("--no-json", action="store_true", help="Compact JSON output")
    parser.add_argument("--header", action="append", default=[], help="Extra header e.g. 'Authorization: Bearer ...'")
    parser.add_argument("--timeout", type=int, default=API_TIMEOUT_SECONDS, help="HTTP timeout in seconds")
    parser.add_argument("--verbose", action="store_true", help="Include diagnostics")
    return parser.parse_args()


def build_headers(values: list[str]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for value in values:
        if ":" not in value:
            continue
        key, raw = value.split(":", 1)
        headers[key.strip()] = raw.strip()
    return headers


def parse_github_pr(url: str) -> Optional[tuple[str, int]]:
    match = re.search(r"^https://github\.com/([^/]+/[^/]+)/pull/(\d+)(?:/.*)?$", url.strip())
    if not match:
        return None
    return match.group(1), int(match.group(2))


def parse_pr_from_run(run: Optional[dict]) -> Optional[tuple[str, int, str]]:
    if not isinstance(run, dict):
        return None

    urls = [run.get("prUrl"), run.get("reviewUrl")]
    for url in urls:
        if not isinstance(url, str):
            continue
        parsed = parse_github_pr(url)
        if parsed is None:
            continue
        return parsed[0], parsed[1], url
    return None


def is_pr_mergeable(pr_state: str, merge_state: Optional[str]) -> bool:
    if pr_state.upper() not in ALLOWED_MERGE_STATES:
        return False
    if merge_state is None:
        return True
    return merge_state.upper() in MAYBE_MERGEABLE_STATES


def has_task_dependency_block(task: dict) -> bool:
    state = task.get("dependencyState")
    return bool(isinstance(state, dict) and state.get("blocked", False))


def is_auto_start_eligible(task: dict) -> bool:
    automation = task.get("automationState")
    if not isinstance(automation, dict):
        return True
    return automation.get("autoStartEligible", True) is not False


def task_sort_key(task: dict) -> tuple[str, str]:
    return (task.get("createdAt") or "", task.get("taskId") or "")


def repo_slug_by_id(snapshot: dict) -> dict[str, str]:
    return {repo.get("repoId"): repo.get("slug") for repo in snapshot.get("repos", []) if isinstance(repo, dict)}


def make_manual_item(
    task_id: str,
    run_id: Optional[str],
    repo: str,
    pr_url: Optional[str],
    reason: str,
    required_action: str,
    next_hint: str,
    command: Optional[str] = None,
) -> dict[str, object]:
    return {
        "taskId": task_id,
        "runId": run_id,
        "repo": repo,
        "prUrl": pr_url,
        "reason": reason,
        "requiredAction": required_action,
        "suggestedNext": next_hint,
        "commandHint": command,
        "handoff": True,
    }


def valid_options(args: argparse.Namespace) -> list[dict[str, str]]:
    return [
        {"flag": "--api-base http://localhost:5173", "description": "Target API base URL"},
        {"flag": "--mode plan", "description": "Read-only scan and plan (default)"},
        {"flag": "--mode run", "description": "Apply merges and start tasks"},
        {"flag": "--execute", "description": "Shortcut for --mode run"},
        {"flag": f"--max-active {args.max_active}", "description": "Upper bound of ACTIVE tasks"},
        {"flag": f"--single-repo <repoId>", "description": "Optional repo filter"},
        {"flag": f"--merge-strategy {args.merge_strategy}", "description": "gh merge strategy (squash|merge|ff-only|rebase)"},
        {"flag": "--dry-run", "description": "Show actions without applying"},
        {"flag": "--json", "description": "Pretty print payload"},
    ]


def run_cycle(args: argparse.Namespace) -> dict[str, object]:
    mode = "run" if args.mode == "run" or args.execute else "plan"
    if args.dry_run:
        mode = "plan"

    can_execute = mode == "run" and not args.dry_run
    headers = build_headers(args.header)

    api = KanbanApiClient(args.api_base, headers=headers, timeout=args.timeout)
    gh_client = GhClient(dry_run=not can_execute)

    board_payload = api.get_board(args.single_repo or "all")
    tasks = board_payload.get("tasks", []) if isinstance(board_payload.get("tasks"), list) else []
    runs = board_payload.get("runs", []) if isinstance(board_payload.get("runs"), list) else []
    run_by_id = {run.get("runId"): run for run in runs if isinstance(run, dict)}
    repos = repo_slug_by_id(board_payload)

    completion_actions: list[dict[str, object]] = []
    merge_actions: list[dict[str, object]] = []
    activation_actions: list[dict[str, object]] = []
    manual_items: list[dict[str, object]] = []

    review_tasks = [task for task in tasks if isinstance(task, dict) and task.get("status") == TASK_STATUS_REVIEW]
    active_count = sum(1 for task in tasks if isinstance(task, dict) and task.get("status") == TASK_STATUS_ACTIVE)

    for task in review_tasks:
        task_id = task.get("taskId")
        if not isinstance(task_id, str):
            continue

        run = None
        run_id = task.get("runId")
        if isinstance(run_id, str):
            run = run_by_id.get(run_id)
            if run is None:
                try:
                    run = api.get_run(run_id)
                    if isinstance(run, dict):
                        run_by_id[run_id] = run
                except RuntimeError:
                    run = None

        repo = repos.get(task.get("repoId"), task.get("repoId", "unknown"))
        pr_ref = parse_pr_from_run(run)

        # 1) If run already reports merge completion, finalize task.
        if isinstance(run, dict) and str(run.get("reviewState", "")).lower() == "merged":
            action = {
                "taskId": task_id,
                "runId": run.get("runId") if isinstance(run, dict) else run_id,
                "action": "mark_done",
                "status": "planned",
                "detail": "run.reviewState=merged",
            }
            if can_execute:
                try:
                    api.patch_task_status(task_id, TASK_STATUS_DONE)
                    action["status"] = "applied"
                except RuntimeError as error:
                    action["status"] = "failed"
                    action["error"] = str(error)
            completion_actions.append(action)
            continue

        # 2) Need PR context to continue merging.
        if not pr_ref:
            manual_items.append(make_manual_item(
                task_id=task_id,
                run_id=run_id,
                repo=str(repo),
                pr_url=run.get("prUrl") if isinstance(run, dict) else None,
                reason="missing_pr_reference",
                required_action="Attach PR URL on run (prUrl/reviewUrl)",
                next_hint="Provide PR link or rerun if it appears in the run now.",
            ))
            continue

        run_repo, pr_number, pr_url = pr_ref
        action_cmd = f"gh pr merge {pr_number} -R {run_repo}"

        if not can_execute:
            merge_actions.append(
                {
                    "taskId": task_id,
                    "runId": run_id,
                    "action": "plan_merge",
                    "status": "planned",
                    "detail": "Review task with PR found",
                    "command": f"{action_cmd} {MERGE_FLAGS[args.merge_strategy]} --admin --delete-branch",
                    "prUrl": pr_url,
                }
            )
            continue

        if not gh_client.can_call():
            manual_items.append(make_manual_item(
                task_id=task_id,
                run_id=run_id,
                repo=str(repo),
                pr_url=pr_url,
                reason="gh_cli_missing",
                required_action="Install and authenticate GitHub CLI",
                next_hint="Install gh and rerun with --mode run",
                command="brew install gh",
            ))
            continue

        # 3) Check PR state and mergeability.
        pr_state, merge_state, pr_error = gh_client.pr_view(run_repo, pr_number)
        if pr_error:
            manual_items.append(make_manual_item(
                task_id=task_id,
                run_id=run_id,
                repo=str(repo),
                pr_url=pr_url,
                reason="gh_pr_view_failed",
                required_action="Inspect PR manually",
                next_hint="Run gh pr view with matching repo and PR number",
                command=f"gh pr view {pr_number} -R {run_repo}",
            ))
            continue

        if pr_state.upper() == "MERGED":
            action = {
                "taskId": task_id,
                "runId": run_id,
                "action": "mark_done",
                "status": "planned",
                "detail": "pr_state=MERGED",
            }
            try:
                api.patch_task_status(task_id, TASK_STATUS_DONE)
                action["status"] = "applied"
            except RuntimeError as error:
                action["status"] = "failed"
                action["error"] = str(error)
            completion_actions.append(action)
            continue

        if not is_pr_mergeable(pr_state, merge_state):
            manual_items.append(make_manual_item(
                task_id=task_id,
                run_id=run_id,
                repo=str(repo),
                pr_url=pr_url,
                reason="pr_not_mergeable",
                required_action="Resolve blockers and retry",
                next_hint="Fix conflicts/check failures/branch protection blockers, then rerun",
                command=f"{action_cmd} {MERGE_FLAGS[args.merge_strategy]} --admin --delete-branch",
            ))
            continue

        merge = gh_client.pr_merge(run_repo, pr_number, args.merge_strategy)
        merge_actions.append(
            {
                "taskId": task_id,
                "runId": run_id,
                "action": "gh_pr_merge",
                "status": "applied" if merge.returncode == 0 else "failed",
                "detail": "pr_merge",
                "command": f"{action_cmd} {MERGE_FLAGS[args.merge_strategy]} --admin --delete-branch",
                "prUrl": pr_url,
            }
        )

        if merge.returncode != 0:
            manual_items.append(make_manual_item(
                task_id=task_id,
                run_id=run_id,
                repo=str(repo),
                pr_url=pr_url,
                reason="gh_pr_merge_failed",
                required_action="Resolve conflict or open worktree and continue",
                next_hint=(
                    "Open the PR locally, resolve merge blockers, complete the merge,"
                    " then rerun this script for handoff continuation."
                ),
                command=f"{action_cmd} {MERGE_FLAGS[args.merge_strategy]} --admin --delete-branch",
            ))
            continue

        # Merge command succeeded; mark task done.
        completion_action = {
            "taskId": task_id,
            "runId": run_id,
            "action": "mark_done_after_merge",
            "status": "planned",
            "detail": "gh_pr_merge succeeded",
        }
        try:
            api.patch_task_status(task_id, TASK_STATUS_DONE)
            completion_action["status"] = "applied"
        except RuntimeError as error:
            completion_action["status"] = "failed"
            completion_action["error"] = str(error)
            manual_items.append(make_manual_item(
                task_id=task_id,
                run_id=run_id,
                repo=str(repo),
                pr_url=pr_url,
                reason="mark_done_failed",
                required_action="Update task status manually",
                next_hint="Call PATCH /api/tasks/{taskId} with {\"status\": \"DONE\"}",
                command=f"PATCH /api/tasks/{task_id} {{\"status\": \"DONE\"}}",
            ))
        completion_actions.append(completion_action)

    # Activation pass: fill open ACTIVE capacity with auto-start-eligible INBOX/READY tasks.
    if args.single_repo:
        activation_candidates = [
            task
            for task in tasks
            if isinstance(task, dict)
            and task.get("status") in TASK_STATUSES_TO_START
            and task.get("repoId") == args.single_repo
            and not has_task_dependency_block(task)
            and is_auto_start_eligible(task)
        ]
    else:
        activation_candidates = [
            task
            for task in tasks
            if isinstance(task, dict)
            and task.get("status") in TASK_STATUSES_TO_START
            and not has_task_dependency_block(task)
            and is_auto_start_eligible(task)
        ]
    activation_candidates = sorted(activation_candidates, key=task_sort_key)

    slots = max(0, args.max_active - active_count)
    for candidate in activation_candidates[:slots]:
        task_id = candidate.get("taskId")
        if not isinstance(task_id, str):
            continue

        if can_execute:
            try:
                api.patch_task_status(task_id, TASK_STATUS_ACTIVE)
                run = api.start_task(task_id)
                activation_actions.append(
                    {
                        "taskId": task_id,
                        "action": "start_run",
                        "status": "applied",
                        "runId": run.get("runId") if isinstance(run, dict) else None,
                    }
                )
            except RuntimeError as error:
                activation_actions.append(
                    {
                        "taskId": task_id,
                        "action": "start_run",
                        "status": "failed",
                        "error": str(error),
                    }
                )
                manual_items.append(
                    make_manual_item(
                        task_id=task_id,
                        run_id=candidate.get("runId"),
                        repo=str(candidate.get("repoId", "unknown")),
                        pr_url=None,
                        reason="activation_failed",
                        required_action="Retry starting the task",
                        next_hint="Fix the reported error and rerun script",
                        command=f"PATCH /api/tasks/{task_id} {{\"status\": \"ACTIVE\"}} then POST /api/tasks/{task_id}/run",
                    )
                )
        else:
            activation_actions.append(
                {
                    "taskId": task_id,
                    "action": "start_run",
                    "status": "planned",
                    "runId": None,
                }
            )

    current_review_count = len(review_tasks)
    current_inbox_ready_count = sum(
        1 for task in tasks if isinstance(task, dict) and task.get("status") in TASK_STATUSES_TO_START
    )

    cycle_id = datetime.now(timezone.utc).isoformat()
    requires_attention = len(manual_items) > 0

    result: dict[str, object] = {
        "cycle_id": cycle_id,
        "mode": mode,
        "can_execute": can_execute,
        "dry_run": bool(args.dry_run),
        "summary": {
            "tasks_review": current_review_count,
            "tasks_active": active_count,
            "tasks_inbox_or_ready": current_inbox_ready_count,
            "active_capacity": args.max_active,
            "slots_available": max(0, args.max_active - active_count),
            "single_repo": args.single_repo or "all",
            "requires_attention": requires_attention,
        },
        "actions": {
            "completion": completion_actions,
            "merge": merge_actions,
            "activation": activation_actions,
            "manual": manual_items,
        },
        "handoff": {
            "requires_attention": requires_attention,
            "next_mode": "run" if mode == "plan" else "run",
            "next_command_hint": "python scripts/agentkanban_autosweep.py --mode run --max-active {max_active} --merge-strategy {strategy} {single_repo} {json}".format(
                max_active=args.max_active,
                strategy=args.merge_strategy,
                single_repo=(f"--single-repo {args.single_repo} " if args.single_repo else ""),
                json=("--json " if args.json else ""),
            ).strip(),
            "valid_options": valid_options(args),
            "note": "Run with --mode run when you are ready to apply merges/starts; use --dry-run to preview actions first.",
            "first_run_default": "This script defaults to --mode plan. Re-run with --execute or --mode run."
            if args.mode == "plan"
            else "",
        },
    }

    if args.verbose:
        result["debug"] = {
            "task_count": len(tasks),
            "run_count": len(runs),
            "repo_count": len(repos),
            "timestamp": cycle_id,
        }

    return result


def main() -> None:
    args = parse_args()
    if args.execute:
        args.mode = "run"

    try:
        payload = run_cycle(args)
        if args.no_json:
            print(json.dumps(payload, separators=(",", ":")))
        elif args.json:
            print(json.dumps(payload, indent=2))
        else:
            print(json.dumps(payload))

        if payload.get("summary", {}).get("requires_attention"):
            sys.exit(2)
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"cycle_status": "error", "error": str(error)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
