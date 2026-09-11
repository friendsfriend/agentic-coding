## Context

Depends on `port-project-catalog-and-state-to-bun`. Mature Go integrations back repository search, GitHub/GitLab issues and change requests, CI, sessions and AI streaming. The Bun gateway already exposes stable contracts and owns configuration/state; operational action execution remains Go-owned until the next change.

## Goals / Non-Goals

**Goals:** Compatible Bun integration services with provider-specific behavior, scoped AI callbacks and preserved command audit history.

**Non-Goals:** New providers, replacing Herdr agents, a generic agent platform or duplicating mutations to compare implementations.

## Decisions

1. Port by route family: provider configuration/repository search; Git reads; GitHub/GitLab reads; provider mutations/CI controls; session discovery and AI streams. Maintain a route ownership manifest. Compare read results through deterministic fixtures and sandbox accounts; switch mutation ownership only after fixtures pass. Never shadow real writes.
2. Use existing HTTP primitives and safe Git argv execution where behavior matches. Identify go-git/SDK-specific behavior before replacing it; preserve credential handling, cancellation and worktree safety. No shell interpolation of repository/user-supplied data. Provider errors map to existing bounded client diagnostics, with retries only where operation semantics permit.
3. Keep provider-specific identifiers, pagination totals, diff positions/version references and approval/discussion semantics. Filtering/search/sorting occur before pagination. Do not flatten GitHub and GitLab differences into a lossy lowest-common-denominator model.
4. Where registered Go actions call a migrated Git capability, use a private operation adapter tied to run/step execution identity. Existing action owner records actual commands/output exactly once; the Bun integration does not create another action tree. The adapter forwards cancellation and idempotency identity and cannot recursively re-enter the same public action route. It is removed after Bun action cutover.
5. Preserve Pi RPC streaming, session identity and user-visible analysis/review behavior. Callback tokens are unguessable, short-lived, scoped to review/project/CR, and revoked on stream close. Temporary worktrees have explicit ownership markers and are removed only if owned; cancellation terminates owned child process and redacts secrets. Session JSONL parsing is bounded and does not execute file contents.

## Risks / Trade-offs

- Provider parity misses uncommon pagination/approval behavior → port existing Go fixtures and add edge cases before route switch.
- Git mutation collides with running workflow checkout → canonical project/worktree identity and existing ownership checks; never retarget workflow pins.
- AI cleanup deletes user worktree → distinguish owned review checkout from pre-existing/adopted checkout and test cancellation/failure paths.
- Lost response repeats a write → reconcile by operation identity; no generic POST retry.

## Migration Plan

Capture route contracts and private action adapter shape; port reads before writes and streams; change owner for each complete route family; retain unchanged public clients where possible. Require script/provider/Git/AI inventory coverage. Rollback changes route owner only when in-flight requests/actions have settled; persisted state remains compatible and no writes are replayed.

## Open Questions

No blocking product choices. Provider credentials and real integration-test accounts are supplied through existing secure configuration; tests use fakes by default.
