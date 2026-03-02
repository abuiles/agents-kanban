# AgentsKanban GitLab Self-Hosted Setup

## Purpose

AgentsKanban supports both hosted GitLab (`https://gitlab.com`) and self-hosted GitLab instances.

Runtime behavior uses:

- GitLab HTTP APIs against the configured `scmBaseUrl`
- git-over-HTTPS clone/push using the configured project path and token

Operator tools like `glab` are optional. They are useful for smoke tests and validation, but they are not a runtime dependency.

## Prerequisites

Before adding a self-hosted GitLab repo to AgentsKanban, make sure you have:

- a reachable GitLab base URL such as `https://gitlab.example.com`
- the GitLab project path, such as `group/subgroup/repo`
- the default branch name, usually `main`
- a token that can:
  - call the GitLab REST API
  - create merge requests and notes
  - inspect pipeline and commit status data
  - compare a commit against the default branch
  - push branches over HTTPS

The runtime environment must be able to reach the self-hosted GitLab origin over HTTPS.

## Repo configuration

In the repo settings UI, set:

- `SCM provider`: `GitLab`
- `GitLab base URL`: the origin only, for example `https://gitlab.example.com`
- `Project path`: the GitLab project path, for example `group/subgroup/repo`
- `Default branch`: the repository default branch, usually `main`

Important normalization rules:

- the base URL is normalized to origin form
- the project path should not include leading or trailing slashes
- subgroup paths are supported

Examples:

- hosted GitLab:
  - `scmBaseUrl = https://gitlab.com`
  - `projectPath = group/platform/demo`
- self-hosted GitLab:
  - `scmBaseUrl = https://gitlab.example.com`
  - `projectPath = group/subgroup/demo`

## Credential model

GitLab credentials are host-scoped in AgentsKanban.

That means:

- `gitlab.com` uses one credential entry
- `gitlab.example.com` uses a different credential entry
- multiple self-hosted GitLab instances must be configured separately

The current adapter uses:

- `PRIVATE-TOKEN` for GitLab API requests
- `https://oauth2:<token>@<host>/<projectPath>.git` for clone/push over HTTPS

Recommended token capabilities for the current implementation:

- `api`
- `write_repository`

If you use a project or group access token instead of a personal access token, it still needs enough permission to:

- create merge requests
- update merge request notes
- read pipeline and commit status data
- compare commits against the default branch
- push branches

## Supported task source refs

The current GitLab adapter accepts these self-hosted GitLab source ref forms:

- merge request URL:
  - `https://gitlab.example.com/group/project/-/merge_requests/42`
- subgroup merge request URL:
  - `https://gitlab.example.com/group/subgroup/project/-/merge_requests/42`
- branch URL:
  - `https://gitlab.example.com/group/subgroup/project/-/tree/feature/name`
- commit URL:
  - `https://gitlab.example.com/group/project/-/commit/<sha>`
- raw merge request head ref:
  - `refs/merge-requests/42/head`

Task prompts can also mention:

- GitLab MR URLs
- MR numbers in text such as `MR !42`
- branch names
- commit SHAs

## Expected review flow

For a self-hosted GitLab repo, the runtime should behave like this:

1. A task starts from the configured default branch or an explicit source ref.
2. AgentsKanban creates and pushes a run branch.
3. The GitLab adapter creates a merge request against the configured default branch.
4. The task moves to `REVIEW`.
5. After the MR is merged and the commit is reachable from the default branch, downstream Stage 3.1 fanout logic can treat it as landed.

GitHub pull requests and GitLab merge requests are intentionally treated as the same review lifecycle in the product.

## Operator smoke test with `glab`

`glab` is optional, but it is a good way to validate a self-hosted GitLab setup.

Example checks:

```bash
glab auth login --hostname gitlab.example.com
glab repo view group/subgroup/repo --hostname gitlab.example.com
glab mr list --repo group/subgroup/repo --hostname gitlab.example.com
```

After AgentsKanban opens an MR, you can validate:

```bash
glab mr view 42 --repo group/subgroup/repo --hostname gitlab.example.com
glab mr checks 42 --repo group/subgroup/repo --hostname gitlab.example.com
```

Recommended smoke-test sequence:

1. Configure the repo with `SCM provider = GitLab`.
2. Configure the GitLab host credential for the same hostname.
3. Start a task against that repo.
4. Verify the run creates a branch on the target GitLab instance.
5. Verify the MR opens on the target GitLab instance.
6. Merge the MR.
7. Verify downstream readiness treats the change as merged to the default branch.

## Troubleshooting

### Invalid base URL

Use origin form only:

- good: `https://gitlab.example.com`
- bad: `https://gitlab.example.com/group/repo`

### Wrong project path

Use GitLab project path form:

- good: `group/subgroup/repo`
- bad: `/group/subgroup/repo/`

### Wrong host credential

GitLab credentials are keyed by host. A credential stored for `gitlab.com` will not be used for `gitlab.example.com`.

### API works but push fails

Your token likely has enough API access to create MRs but does not have enough repository write permission for HTTPS push.

### Push works but MR creation fails

Your token may allow git operations but not the GitLab API calls needed for merge request creation or note updates.

### GitLab URL is rejected as unsupported

The adapter only accepts GitLab URLs from the configured host for that repo. If the repo is configured for `https://gitlab.example.com`, URLs from another host will be rejected.

### Subgroup path mismatch

Make sure the configured `projectPath` exactly matches the GitLab project path, including subgroup segments.

### Merge completed but downstream work does not unblock

Stage 3.1 fallback readiness requires both:

- the review to be merged
- the merged commit to be reachable from the default branch

If the MR shows merged but the commit is not yet visible from the target default branch, downstream tasks will not unblock yet.

## Notes

- Runtime GitLab integration is host-based and adapter-driven.
- `glab` is for operator validation only.
- This document covers token-based setup only.
- OAuth app auth and webhooks are out of scope for the current GitLab integration pass.
