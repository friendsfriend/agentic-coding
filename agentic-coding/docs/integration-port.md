# Git, provider and AI integration port

`port-git-providers-and-ai-to-bun` moves the Git/provider/GitHub/GitLab/CI and
AI/session backend surface from the Go child into the Bun server, one route
family at a time, with Go-created fixtures as the parity evidence. The Bun
server becomes the single front door for the legacy devenv `/api/*` surface;
families that are not ported yet are delegated to the private Go child exactly
like `/api/v1/environment/*` is today (see
[`unified-backend-api.md`](unified-backend-api.md)).

## Prerequisite

`port-project-catalog-and-state-to-bun` is implemented and archived: Bun owns
`$DEVENV_HOME/db/state.db` and the configured environment (definition files,
catalog projection) by default, and the Go child reaches both through the
bounded private operations in `src/server/environment/private-api.ts`. This
port builds on that authority: a Git/provider route resolves its app through
the Bun catalog instead of a Go `AppManager` lookup.

## Route ownership manifest

`LEGACY_ROUTE_OWNERSHIP` in `src/server/integrations/protocol.ts` is the static
manifest for the legacy surface. `bun` entries are served in-process; every
other `/api/*` path is delegated to the private Go child. There is no router
framework and no per-request owner guessing.

| Family | Routes | Owner | Task |
| --- | --- | --- | --- |
| git | `GET /api/git/branches`, `GET/POST/PATCH/DELETE /api/git/worktrees` | bun | 2.2–2.4 |
| providers | `GET/POST /api/providers`, `GET/PUT/DELETE /api/providers/{name}` | bun | 2.1 |
| repos | `POST /api/repos/search`, `GET /api/repos/branches` | bun | 2.1 |
| github | 24 routes under `/api/github/*` | bun | 3.1–3.4 |
| gitlab | 30 routes under `/api/gitlab/*` | bun | 3.5–3.8 |
| ai | `POST /api/ai/analyze-logs`, `POST /api/ai/analyze-logs-stream`, `POST /api/ai/cr-review-stream`, `POST /api/ai/cr-comment-callback/{token}` | bun | 4.1–4.4 |
| system | `GET /api/pi-sessions` | bun | 4.1 |
| app | `/api/apps*`, `/api/projects`, `/api/status`, `/api/infra-services*`, `/api/example-config` | go | `port-environment-runtimes-to-bun` |
| actions | `/api/action-runs`, `/api/actions/*`, `/api/apps/{ident}/actions`, `/api/action-definition`, `/api/action-registry/status` | go | `port-action-execution-to-bun` |
| docker / kubernetes | `/api/docker/*`, `/api/kubernetes/*` | go | `port-environment-runtimes-to-bun` |
| scripts | `/api/scripts*` | go | `port-action-execution-to-bun` |

`/api/apps/{ident}/git` (branch + status) and `/api/apps/{ident}` reads use the
Git capability but belong to the app family; they switch with that family and
consume the Bun Git service then.

## Go callers of the migrated Git capability

Inventory of the Go code that reaches `pkg/git` (recorded here so the adapter
and the cutover order stay explicit):

| Caller | Capability | Handling |
| --- | --- | --- |
| `pkg/server/handlers_git.go` `handleGitBranches` / `handleWorktrees` | local/remote branches, current branch, worktree list/add/remove | Bun-owned route family (2.2–2.4) |
| `pkg/server/server.go` `startGitPoller` | `GetCurrentBranch`, `GetStatus` every 5s | stays Go until the app family switches; reads only |
| `pkg/server/server.go` `broadcastAppStatus` / `WithBranch` | `GetCurrentBranch`, `GetStatus` | stays Go until the app family switches; reads only |
| `pkg/server/server.go` `updateOrCreateRepoWithStatus` | `UpdateOrCreateRepo` (clone + switch + pull) | Go-owned action path; uses the private adapter (2.5) |
| `pkg/server/handlers_apps.go` `handleGetGitInfo`, `handleRepoBranches` | `GetCurrentBranch`, `GetStatus`, `GetBranches` | app/repos family; repos switches here (2.1), app later |
| `pkg/server/handlers_github.go`, `handlers_gitlab.go` | `GetCurrentBranch` | reads only, switches with the provider families (3.x) |
| `pkg/server/handlers_git.go` `handleGitPull/Push/Fetch/Checkout` | `Pull`, `Push`, `Fetch`, `Checkout` | unrouted legacy handlers; no live caller |
| `pkg/actionregistry/git.go` (compiled `git` command steps) | `git` argv per step | Go action owner records; the argv crosses the private adapter (2.5) until `port-action-execution-to-bun` task 4.3 removes the bridge |

## GitHub family (ported)

`src/server/integrations/` now serves the whole GitHub surface in-process:

| Module | Content |
| --- | --- |
| `github-client.ts` | authenticated request, owner/repo extraction, `Link` pagination, sorted query parameters, repository search |
| `github-issues.ts` | issue list/detail/comments, mutations, labels/collaborators, linked change requests and referenced issues |
| `github-changerequest.ts` | pull request list/detail, changed files with positioned diff lines, discussions, approvals, close, inline comment, reply, workflow jobs and job logs |
| `github-routes.ts` | the 24 routes, their status codes, envelopes and the check-run test-summary aggregation |

Deliberate differences from the Go implementation, all visible in the fixtures:

- **`approved_by` is sorted by username.** The Go client iterated a map, so its
  order was incidental; a fixture can only be a contract if the order is stable.
  `canonicalFixtureValue` in the generator sorts the Go value the same way.
- **The search-hit conversion keeps the Go quirk.** `searchPullRequests` rebuilds a
  partial provider payload, so a search hit has `id: 0` and `merge_status:
  checking` even though the full pull request was loaded; the port reproduces it
  rather than "fixing" it, because the TUI's rendering is calibrated to it.
- **`state=all` issue listing** falls back to the list endpoint (search cannot
  express `state:all`), reports `totalCount: -1` and filters pull requests after
  parsing. Issue search does not clamp the page size; repository search does.
- **The test-summary regexes keep Go's order**, including the quirk that
  `"passed: 3 failed: 1"` counts 3 failed. Pinned on both sides by
  `server/pkg/server/test_summary_test.go` and
  `test/integration-github-routes.test.ts`.

## GitLab family (ported)

| Module | Content |
| --- | --- |
| `gitlab-client.ts` | `PRIVATE-TOKEN` request boundary, `namespace/project` path encoding, `X-Total`/`X-Total-Pages`/`X-Page` pagination, project search |
| `gitlab-issues.ts` | issue list/detail/notes, mutations, labels/members, linked change requests (`closed_by` + issue links + inline `!N`) and referenced issues |
| `gitlab-changerequest.ts` | merge-request list/detail, changed files with positioned diff lines, versions (+ `diff_refs` fallback), discussions, comment/reply/resolve, approve/unapprove/toggle, rebase, close |
| `gitlab-ci.ts` | pipelines, pipeline jobs, job traces, test reports, retry and cancel |
| `gitlab-routes.ts` | the 30 routes, their status codes, envelopes and the branch/scope handling |

Deliberate differences from the Go implementation, all visible in the fixtures:

- **Timestamps are rendered as Go's RFC 3339.** GitLab sends milliseconds and
  the Go types stored `time.Time`, so `.000Z` became `Z`. `provider-time.ts`
  trims the fractional zeros for both providers.
- **Two Go quirks are not reproduced**, because they are defects rather than
  behavior: `parseDiffLines` panics on a `base_sha` shorter than 8 characters
  (the `baseSHA[:8]` slice is evaluated before the debug flag is checked), and
  the test-summary handler dereferences a nil summary when `DEVENV_DEBUG=true`
  and the pipeline has no report. The port answers `null` for a missing report
  and parses any length of SHA; the fixtures use full-length SHAs.
- **Zero timestamps on linked issues are reproduced.** The Go conversions for
  `closed_by` and `closes_issues` entries never copied `created_at`/`updated_at`,
  so those render as `0001-01-01T00:00:00Z`; the port keeps that so the client
  sees the same payload.
- **The test-report grouping is not ported**: `FailedTests` and
  `FailedTestGroups` carry `json:"-"`, so they never reached a client.
- **GitLab line codes** are
  `sha1("<base_sha>:<old_path>:<old_line>:<new_path>:<new_line>")`, unlike
  GitHub's path/line form, and line stats are recomputed from the diff
  (excluding `---`/`+++` headers) instead of trusting the provider counts.

## AI and session family (ported)

| Module | Content |
| --- | --- |
| `pi-sessions.ts` | bounded Pi session discovery and JSONL parsing |
| `ai-streams.ts` | `pi --print` log analysis, the 100 KB tail bound and the SSE body |
| `cr-review.ts` | the review checkout, the Pi RPC event mapping, the scoped callback registry and the comment submission |
| `ai-routes.ts` | the five routes plus the session registry singleton |

Deliberate differences from the Go implementation:

- **The two stream routes are `POST`.** `routes.go` declared `GET` for
  `/api/ai/analyze-logs-stream` and `/api/ai/cr-review-stream` while the
  handlers required `POST` (and the devenv clients send `POST`); the manifest and
  dispatcher follow the real contract.
- **Session groups are sorted by name.** The Go grouping iterated a map, so its
  order was incidental; the fixture is captured sorted and the port sorts.
- **The callback route is authorized by its path token, not the instance
  capability.** A review agent runs `curl` against a URL it was given, and
  handing it the instance token would leak that capability into the agent's
  prompt, transcript and history. `isSessionAuthorizedRoute` in `auth.ts`
  exempts exactly `POST /api/ai/cr-comment-callback/<token>`; the handler still
  validates the 128-bit single-review token, the method, the body bounds and the
  browser origin, and every other route keeps requiring the instance bearer
  token (`test/integration-ai.test.ts` asserts both halves).
- **Cleanup is scoped to the owned checkout.** The review directory is a unique
  temp path and only that path is removed, so a pre-existing worktree survives;
  the prompt file lives inside the checkout and is removed with it. A timed-out
  review does not wait on a diagnostic read that an inherited pipe could hold
  open.

## Credential handling

Credentials are resolved on the Bun side from the provider store and travel to
Git as `-c http.extraheader=Authorization: Basic …` argv, never as a shell
string, never in the private adapter envelope, and always redacted in a
recorded command (`http.extraheader=<redacted>`). A provider definition file
with clear-text credentials is reported as invalid instead of loaded.

Host inference is kept byte-for-byte compatible with the Go `multiAuthProvider`:
an app that names a provider wins, otherwise a `github.com` URL is offered the
GitHub credential and **any other URL is offered the GitLab credential**. The
non-GitHub rule is what makes a freshly pasted GitLab repository clonable, and
the URL always comes from a configured app or an explicit request, so it is a
deliberate parity decision rather than an oversight — a reviewer who wants a
stricter rule should tighten it in `credentialsFor`
(`src/server/integrations/services.ts`) and in the Go provider at the same time.

## Private Git operation adapter

`POST /api/v1/integrations/private/git-command` is the bounded envelope the Go
action owner uses while it still owns action execution. It carries exactly one
Git argv invocation plus the run/step/command identity the Go run tree records,
never SQL, a shell string or a provider credential. Bun executes the argv
through the same safe boundary the Bun Git service uses, forwards cancellation
and returns the real stdout/stderr/exit code. It performs no outbound HTTP
request, so it cannot recurse back into the delegated Go child. The adapter is
removed by `port-action-execution-to-bun` task 4.3.

## Evidence

- `server/pkg/integrations/fixtures_test.go` generates the Go-created fixtures
  under `agentic-coding/test/fixtures/integrations/` (regenerate with
  `DEVENV_INTEGRATION_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/integrations go test ./pkg/integrations -run TestWriteIntegrationFixtures`).
- `test/integration-git-providers.test.ts` asserts Bun reproduces them.
- Parity is fixture- or isolated-test-system based. No mutation is ever
  replayed against both runtimes to compare answers.

## Verification and cutover

- **Combined verification:** `biome check`, `tsc --noEmit`, `bun test`,
  `test:devenv`, `go test ./...` and `go vet ./...`. The only failing Bun test is
  the pre-existing `test/otel/shellHelp.test.tsx` "`?` opens the catalog help
  modal on the wiki tab" timeout, which reproduces on a pristine tree.
- **Cutover:** `test/integration-cutover.test.ts` runs the **unchanged** devenv
  client (`@devenv/core`) against the unified Bun server with a stub Go child and
  proves that provider/repository-search, issue, change-request, CI and Pi-session
  journeys are answered by Bun, that an unported family (`/api/apps`) is delegated
  to the child, that no request is ever seen by both runtimes, and that clearing
  `AGENTIC_DEVENV_FORWARD_URL` rolls the client back to the child.
- **Packaged smoke:** the built `dist/agentic-coding server` starts outside the
  source tree with a temporary `DEVENV_HOME`/`DEVENV_CONFIG_DIR`, the Go child
  answers `/api/health` with the identity of the instance that was started, and
  the Bun server answers `401` without the instance capability on both a
  Bun-owned (`/api/providers`) and a delegated (`/api/apps`) legacy route — so the
  authorization boundary holds on the real artifact.
- **Unavailable live-provider coverage:** every provider fixture replays recorded
  responses through an injected `fetch`; no live GitHub/GitLab account, no real
  `pi` session and no interactive terminal journey is exercised here. Those are
  the test-verifier's scope, and they need credentials this port must not require.
- **Remaining Go owners:** the `app`, `actions`, `docker`, `kubernetes`, `scripts`
  families and `/api/events` + `/api/health` are still Go-served (see the manifest
  table above) and belong to `port-action-execution-to-bun` and
  `port-environment-runtimes-to-bun`. The private Git operation adapter is still
  Go-called and is removed by `port-action-execution-to-bun` task 4.3.

## Rollback

Route ownership is a manifest entry per family, and the client cutover is one
environment variable. Rolling back means clearing `AGENTIC_DEVENV_FORWARD_URL`
(the environment client's transport returns to its own base URL, i.e. the Go
child) and, if a family's ownership itself must move back, restoring the `go`
owner for that family in `LEGACY_ROUTE_OWNERSHIP` after in-flight requests have
settled. The Go child still serves every family, so the rollback needs no
restart of a route implementation, and the private Git adapter is additive. No
provider credential, worktree pin, workflow pin or durable state is rewritten by
the cutover.
