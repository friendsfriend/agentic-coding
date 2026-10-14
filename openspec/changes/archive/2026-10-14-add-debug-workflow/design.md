# Design

## Context

Families are registered through `registerBuiltins.ts` with exact
`{id, version, digest}` pins; step behavior lives in `src/workflow/steps/`.
The worktree port attaches an existing branch or creates one from `base`;
proposal/wiki families show how non-delivering families hold in completed.

## Goals / Non-Goals

**Goals:** a no-change investigation workflow with human review; reusable
debug role for sub-agent requests (change 13).

**Non-Goals:** delivering fixes (developer can start a normal workflow from
the report), multi-app orchestration beyond what env tools provide.

## Decisions

- **Detached worktree.** Add `detached: true` to the worktree port's ensure
  request (`git worktree add --detach <path> <branch>` via worktrunk or the
  port's git fallback). Avoids "branch already checked out" and keeps the
  developer's branch untouched.
- **Role is writable.** Edits are probes or candidate fixes; they are reported
  as `changes.patch` evidence at handoff (engine computes `git diff HEAD` plus
  untracked files) so they survive worktree cleanup.
- **Review gate.** Reuses the developer-gate mechanics of plan/wiki approval:
  artifact `debug-report.md` rendered in the artifact view, actions `approve`
  and `follow-up` (comment required). The follow-up comment is injected into
  the next investigate assignment. Bounded cycle declared in the manifest
  (5).
- **Handoff contract.** `complete` requires a non-empty `debug-report.md` with
  the required headings; `blocked` with a message when reproduction is
  impossible (e.g. app has no run target → suggests `env-setup`).
- **`--app` optional.** Without it the agent picks from `env_list` for the
  repository's configured app; repositories mapping to several apps require it.

## Risks / Trade-offs

- [Developer expects fix on branch] → report states that edits are only in the
  patch; documented in the review view.
