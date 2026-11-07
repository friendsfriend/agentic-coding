# Provider parity archive and proposal

Legacy capability inventory (sources: `agentic-coding/src/server/integrations/`,
`agentic-coding/packages/devenv/{types,core,cli}`) and the proposed v2
architecture for GitLab/GitHub provider APIs on the new server. No code yet;
open decisions are marked `[DECISION]` and need the developer before building.

## 1. Archived legacy surface

### Provider registry (`/api/providers`, `provider-store.ts`)

- Named providers: `{name, type: github|gitlab, username}`. Tokens live only in
  the config `.env` as env-var references; the API projects `{..., has_token}`
  and never echoes a token. Empty token on edit keeps the stored reference;
  values resolved from the process environment are never materialized into
  `.env`. Name collisions on env credential keys are refused.
- Client seam: `gitlab-client.ts` / `github-client.ts` take an injectable
  `fetch` so tests replay recorded responses
  (`agentic-coding/test/fixtures/integrations/{gitlab,github}/`). Auth:
  `PRIVATE-TOKEN` (GitLab), Bearer (GitHub). Tokenless providers fail closed.

### Route families (from `integrations/routes.ts`)

| Family | Routes (count) | Verbs |
|---|---|---|
| providers | `/api/providers`, `/api/providers/{name}` (5) | GET POST PUT DELETE |
| repos | `/api/repos/search`, `/api/repos/branches` (2) | POST GET |
| github CRs | `pull-requests`, `pull-request`, `pr-changes`, `pr-discussions`, `pr-approve`, `pr-unapprove`, `pr-toggle-approval` (7) | GET/POST |
| github CI | `actions-jobs`, `actions-test-summary`, `actions-job-logs` (3) | GET |
| github issues | `issues`, `issue`, `issue-comments`, `issues/close`, `issues/reopen`, `issues/labels`, `issues/assignee`, `issues/unassign`, `issues/comment`, `issues/linked-crs`, `issues/references`, `cr/linked-issues`, `labels`, `collaborators` (14) | GET/POST |
| gitlab CRs | `merge-requests`, `cr-changes`, `cr-versions`, `cr-comment`, `cr-discussions`, `cr-discussion-reply`, `cr-discussion-resolve`, `cr-approve`, `cr-unapprove`, `cr-toggle-approval`, `cr-rebase` (11) | GET/POST |
| gitlab CI | `jobs`, `test-summary`, `job-logs`, `job-retry`, `job-cancel` (5) | GET/POST |
| gitlab issues | same 14 shapes as github under `/api/gitlab/` (14) | GET/POST |

~61 provider routes. Out of scope for this proposal (not provider APIs):
`git/*` worktrees, `docker/*`, `kubernetes/*`, `actions/*` runs, `scripts/*`,
`ai/*`, `apps/*` slots (v2 covers slots via holds/leases).

### TUI consumption (`packages/devenv/cli/src/tui`, `core/src/*-client.ts`)

Views (slots, issues, CRs, pipelines, logs, search) call the clients above over
`serverUrl` with an instance capability. Clients tolerate older servers
(optional fields only when present). This tolerance is what makes
path-compatible parity valuable: the same TUI keeps working.

## 2. Proposed v2 architecture

### 2.1 Module layout (new, no legacy imports)

- `src/providers/config.ts` — `readProviders`: named `{name, type, baseUrl?, username, tokenRef}`; token resolved at call time from `process.env[tokenRef]` only; projection strips the token. Unknown type, empty name, duplicate name, or unresolvable ref refused at config load (fail fast, like `orchestratorProfile`).
- `src/providers/github.ts`, `src/providers/gitlab.ts` — pure clients over an
  injected `fetch`-compatible. Bounded responses (64 KiB), timeouts, normalized
  `{ok, error}` results. Auth headers set inside; tokens never leave the module.
- `src/providers/routes.ts` — thin HTTP adapters; request admission first
  (unknown provider, tokenless provider, malformed IDs, oversized bodies,
  query-param rejection), then client call, then redacted response.
- `src/providers/receipts.ts` — durable write receipts in the pi engine keyed
  by `requestId` digest: comment/approve/resolve/retry are replay-safe
  (same-requestId replays return the recorded outcome; different input under a
  reused requestId is refused). Reads stay stateless.

### 2.2 Parity mechanism: path compatibility `[DECISION]`

Proposed: serve the **exact legacy paths** (`/api/github/*`, `/api/gitlab/*`,
`/api/repos/*`, `/api/providers`) from the v2 server. The old TUI's data layer
then works unchanged against the new server; only its gateway/auth setup is
adapted. Alternative: a new `/api/v2/...` namespace, which forces TUI client
rewrites for zero behavioral gain. Recommendation: legacy paths.

### 2.3 Write gating `[DECISION]`

Reads: capability auth (existing v2 bearer) is enough. Writes (comment,
approve, resolve, rebase, retry, labels, assignees): propose v2-style explicit
approval — the caller presents `approve: <digest>` of the exact write payload,
mirroring promotion. Stricter than legacy, consistent with the rebuilt
backend's "explicit approval for effects" rule. Alternative: bearer-only like
legacy. Recommendation: approval digests for writes.

### 2.4 Response and error posture

v2 style: statuses assert outcomes, details withheld. Provider upstream
messages are not echoed verbatim (they can carry tokens/HTML); map to stable
codes (`unknown-provider`, `tokenless-provider`, `upstream-unavailable`,
`upstream-refused`, `oversized-response`). Redact `PRIVATE-TOKEN`/Bearer/token
strings anywhere they appear, as `http_request` already does.

### 2.5 Tests (minimal per current guidance)

- Recorded-response fixtures ported from
  `agentic-coding/test/fixtures/integrations/` (JSON only, no code import).
- One suite per family proving: unknown provider refused, tokenless fails
  closed, malformed IDs refused, write idempotency replays, oversized upstream
  refused. No live GitHub/GitLab calls, ever.
- No elaborate fake provider servers: the injectable-fetch seam plus recorded
  JSON is the whole harness.

## 3. Phased plan

1. **Foundation**: provider config + projection + registry routes + read routes
   (repos search/branches, CR list/get, issues list/get, jobs list).
2. **Writes**: receipts + approval-gated write routes (comments, approvals,
   discussion resolve/reply, labels/assignees, job retry/cancel, rebase).
3. **TUI gateway**: adapt the old TUI's gateway to the v2 server (paths already
   match under §2.2); no view rewrites.
4. Deferred: GitLab/GitHub Enterprise base URLs beyond a configured allow-list
   (SSRF posture) — propose allow-listed `baseUrl` per provider, defaulting to
   `github.com` / `gitlab.com`.

## 4. Open decisions (developer)

1. Path compatibility (§2.2): legacy paths vs new namespace?
2. Write gating (§2.3): approval digests vs bearer-only?
3. Scope order: read-only first, or registry + reads + writes in one increment?
4. Token storage: env-var references only, or also allow config-file secrets?
5. `baseUrl` allow-list for Enterprise hosts: yes by default?
