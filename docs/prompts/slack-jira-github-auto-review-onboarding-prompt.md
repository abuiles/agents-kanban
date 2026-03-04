# Slack + Jira + GitHub Auto-Review Onboarding Prompt

Use this prompt with an assistant to run a guided setup for Slack-triggered Jira work on GitHub repos, with auto-review enabled using the best provider currently supported.

## Copy/paste prompt

```text
You are my onboarding operator for AgentsKanban integrations.

Goal:
Set up Slack + Jira + GitHub end-to-end so I can run `/kanvy fix <JIRA_KEY>` from Slack on a GitHub repo, and enable auto-review.

Work style:
1. Guide me step-by-step.
2. Ask for missing values only when needed.
3. After each step, give me one verification check.
4. Keep a running checklist with Done/Blocked.
5. Stop on failures and provide the smallest fix first.

Environment:
- App/API base URL: http://localhost:5173
- API base: http://localhost:5173/api
- Worker uses:
  - Worker secrets: `OPENAI_API_KEY`, `GITHUB_TOKEN`, `JIRA_API_TOKEN`, `JIRA_TOKEN`
  - KV binding `SECRETS_KV` for:
    - `slack/signing-secret`
    - `slack/bot-token`
- Slack endpoints:
  - `POST /api/integrations/slack/commands`
  - `POST /api/integrations/slack/events`
  - `POST /api/integrations/slack/interactions`
- Slash command format must be: `/kanvy fix AFCP-1234`

Required outcomes:
1. Slack app configured and installed.
2. GitHub SCM token configured and repo can run tasks.
3. Jira issue fetch works for `/kanvy fix`.
4. Jira project key to repo mapping exists.
5. Slack thread gets status updates and rerun interactions.
6. Auto-review enabled with best available provider:
   - Prefer `github` if supported by current code.
   - If `github` provider is not yet available, configure `jira` now and list exact remaining actions to switch to `github` later.

Please execute this plan:
1. Collect inputs:
   - Slack signing secret, bot token.
   - GitHub PAT and repo (`org/repo`).
   - Jira base URL, email, API token.
   - Jira project key (e.g. AFCP).
   - tenantId and repoId in AgentsKanban.
2. Configure worker secrets:
   - `npx wrangler secret put OPENAI_API_KEY`
   - `npx wrangler secret put GITHUB_TOKEN`
   - `npx wrangler secret put JIRA_API_TOKEN`
   - `npx wrangler secret put JIRA_TOKEN`
3. Configure KV keys:
   - `npx wrangler kv key put --binding=SECRETS_KV "slack/signing-secret" "<value>" --local`
   - `npx wrangler kv key put --binding=SECRETS_KV "slack/bot-token" "<value>" --local`
4. Configure Slack app:
   - Slash command `/kanvy` -> `/api/integrations/slack/commands`
   - Interactivity -> `/api/integrations/slack/interactions`
   - Event URL -> `/api/integrations/slack/events`
   - Scopes: `commands`, `chat:write`
5. Configure repo in AgentsKanban:
   - `scmProvider=github`
   - `scmBaseUrl=https://github.com`
   - `projectPath=<org/repo>`
6. Configure Jira project mapping to repo in D1.
7. Run smoke test:
   - Execute `/kanvy fix <JIRA_KEY>` in Slack.
   - Verify task/run created, Slack thread updates, and repo disambiguation if needed.
8. Configure auto-review:
   - Detect if provider `github` is available.
   - If yes, enable GitHub auto-review and run a test task.
   - If no, enable Jira auto-review now and provide migration checklist for GitHub auto-review.
9. Final output:
   - Completed checklist
   - All commands executed
   - Any blockers
   - Exact next actions to reach full Slack + GitHub auto-review
```

## Token and secret click-map

Use this section when collecting credentials.

### 1) Slack Signing Secret (`slack/signing-secret`)

- Where to click:
1. Open [Slack App Management](https://api.slack.com/apps).
2. Select your app.
3. Go to `Basic Information`.
4. Under `App Credentials`, copy `Signing Secret`.
- Store in KV:
- `npx wrangler kv key put --binding=SECRETS_KV "slack/signing-secret" "<SIGNING_SECRET>" --local`

### 2) Slack Bot Token (`slack/bot-token`)

- Where to click:
1. Open [Slack App Management](https://api.slack.com/apps).
2. Select your app.
3. Go to `OAuth & Permissions`.
4. Under `Bot Token Scopes`, add `commands` and `chat:write`.
5. Click `Install to Workspace` (or `Reinstall`).
6. Copy `Bot User OAuth Token` (`xoxb-...`).
- Store in KV:
- `npx wrangler kv key put --binding=SECRETS_KV "slack/bot-token" "<XOXB_TOKEN>" --local`

### 3) GitHub token (`GITHUB_TOKEN`)

- Where to click:
1. Open [GitHub token settings](https://github.com/settings/tokens).
2. Create a fine-grained token.
3. Limit it to the target repository.
4. Grant minimum required permissions:
- `Contents`: read/write
- `Pull requests`: read/write
- `Metadata`: read
- Save and copy token.
- Store as Worker secret:
- `npx wrangler secret put GITHUB_TOKEN`

### 4) Jira API token (`JIRA_API_TOKEN` and usually `JIRA_TOKEN`)

- Where to click:
1. Open [Atlassian API tokens page](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Click `Create API token` (or `Create API token with scopes`).
3. Name it, set expiry, create, and copy.
- Notes:
- `JIRA_API_TOKEN` is used for Jira issue reads.
- `JIRA_TOKEN` is used for Jira review posting; you can use the same token initially.
- Store as Worker secrets:
- `npx wrangler secret put JIRA_API_TOKEN`
- `npx wrangler secret put JIRA_TOKEN`

### 5) OpenAI API key (`OPENAI_API_KEY`)

- Where to click:
1. Open [OpenAI API keys](https://platform.openai.com/api-keys).
2. Create a new secret key and copy it.
- Store as Worker secret:
- `npx wrangler secret put OPENAI_API_KEY`

## Slack endpoint setup quick checklist

In Slack app settings:

1. `Slash Commands`:
- Command: `/kanvy`
- Request URL: `https://<your-host>/api/integrations/slack/commands`
2. `Interactivity & Shortcuts`:
- Interactivity: On
- Request URL: `https://<your-host>/api/integrations/slack/interactions`
3. `Event Subscriptions` (optional for this flow, but supported):
- Enable events
- Request URL: `https://<your-host>/api/integrations/slack/events`

## Current provider note

As of this repository state, Slack + GitHub SCM + Jira-based auto-review are supported. If GitHub auto-review provider is not yet merged, use Jira provider for auto-review now and switch to GitHub provider once the GitHub auto-review stage is merged.
