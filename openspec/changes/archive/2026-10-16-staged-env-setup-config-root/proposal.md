## Why

The first real `env-setup` run (grid-allocation-backend) proved the workflow does not
test what it publishes. Drafts live in `<config>/.drafts/env-setup/<id>` and are
resolved by a *per-file* overlay, so a drafted compose file resolves its own
relative paths inside the drafts tree: `include: ../../infrastructure/compose/x.yml`
fails, and the author redesigned the file (published host ports instead of the
shared docker network) to fit the draft location. The promoted file is therefore
not the file that was tested. In the same run the developer's live config held
symlinked build/compose files, and the default Dockerfile build target failed
three times with `failed to read dockerfile: ... no such file or directory` —
a failure the validation gate never saw, because the gate only checks structure
and starts the drafted *run* target: it never builds, never runs the test target,
and never uses the real layout. The author also left two build targets for one
app/profile (a Dockerfile target and a host-maven target) with no statement of
which one is the default, so `env_build` silently picked one of them.

This change makes the thing the author runs the thing the developer promotes
(a complete staged configuration root), makes the gate run the developer's real
path against that root, smoke-checks the live configuration after promotion with
rollback, and fixes the two root causes the evidence found in production code.

## What Changes

- **Staged configuration root replaces the per-file overlay.** For an `env-setup`
  workflow the system materializes `<config>/.drafts/env-setup/<id>/root/` = the
  live configuration copied at its own relative layout, with `.env` and
  `providers/` exposed read-only as private copies (never symlinks, which would
  be write-through into the live credential store) and large/irrelevant
  directories (`.drafts`, `.backups`, `wiki`, `telemetry`, `snapshots` and the
  server's discovery record) excluded.
  Live symlinks are recreated as absolute symlinks to their original target, so
  the symlink behaviour the gate exercises is production's. The author writes
  drafts at their final relative paths inside that root; discovery, compose/docker
  invocations (`-f`, `include:`, relative mounts) and every `env_*` tool of the
  workflow's runs resolve against it as if it were the configuration root.
- **Changed files are derived, not assumed.** A base snapshot (per-path content
  digest, kind, symlink target) taken at materialization gives the changed-file
  list, so the approval diff, the promotion plan and the write guard keep their
  current behaviour and semantics.
- **Promotion detects conflicts.** A live file whose content no longer matches
  the base snapshot is refused (never silently overwritten) and reported to the
  developer.
- **Stricter gate.** `setup.validate` discovers/compiles, runs the **default build
  action**, starts the **default run target** with readiness, and runs the
  **default test action** when one exists — against the staged root, deterministically
  and with bounded time and output. Failures return to the author through the
  existing five-round loop; a step the machine cannot run (docker daemon down,
  tool missing, cluster unreachable) is an explicit `skipped: <reason>` finding,
  never a pass. The developer's approval payload names the exact commands/targets
  run, their results, and the default target per action.
- **Post-promotion smoke check with rollback.** A new step after `setup.promote`
  starts the real (live) default target once, records the result, and on failure
  offers the developer a rollback from the promotion backup that restores exactly
  the previous files, or the explicit choice to keep the promotion.
- **Root-cause fixes.** `docker build -f` resolves a symlinked Dockerfile to its
  real path (with a stub-docker regression test); the default build/test/run
  target per app/profile is deterministic and surfaced by `env_list`, the TUI
  build action and the gate report instead of being silently picked; the
  `prepare-build-context` stderr noise is fixed or documented as harmless.
- **Staged roots are swept.** Teardown at close removes the workflow's staged root;
  a stale-root sweep runs at start (the existing refusal to start over leftovers
  is kept).

## Capabilities

### New Capabilities

None. The change reworks the existing `env-setup` family and the seams it uses.

### Modified Capabilities

- `environment-setup-workflow`: the staged root replaces the per-file overlay as
  what is authored, validated and promoted; changed-file derivation, conflict
  detection and teardown/sweep; the gate runs build/start/test against the staged
  root and reports skips; a post-promotion smoke step with rollback.
- `agent-environment-tools`: `env_list` for an `env-setup` run reports the staged
  root's apps/infrastructure and targets, marking default targets and which ones
  came from the staged root; `env_build`/`env_test` resolve the staged root like
  `env_start` does.
- `bun-environment-action-engine`: a symlinked Dockerfile/compose source builds
  and starts (real-path resolution for `-f`); the default build/test target per
  app/profile is deterministic and reported rather than silently chosen.

## Impact

- `src/server/environment/setup-drafts.ts`, new `setup-staged.ts`,
  `setup-validate.ts`, `setup-promote.ts` (conflict detection, exported rollback).
- `src/server/actions/discovery.ts` (overlay resolution: file *or preserved
  symlink*, from a staged root), `src/server/actions/routes.ts` (agent build/test
  overlay + default-target choice), `src/server/actions/target-compile.ts`
  (`docker build -f` real path, `prepare-build-context`), `src/server/runtime/instances.ts`
  (default run target).
- `src/server/integrations/services.ts` (overlay resolver returns the staged root),
  `src/server/environment/agent-routes.ts` (owner-scoped catalog view, staged
  marking, defaults), `src/server/operations/observations.ts` (diff rows unchanged
  in shape).
- `src/workflow/steps/env-setup.ts`, `src/workflow/definitions/steps.ts`,
  `src/workflow/definitions/graphs/env-setup.ts`, `src/workflow/effect-runner.ts`,
  `src/contracts/workflow.ts` (three new effect kinds), `src/workflow/runtime/engine.ts`
  and `src/workflow/startup.ts` (staged-root pin and leftover check).
- `agent-definitions/instructions/env-setup.md` (write into the staged root, name
  the default target), `agentic-coding/docs/agent-environments.md`, TUI
  approval/review view (validation report at the approval step).
- No `STORE_SCHEMA_VERSION` change (stays 6): the staged root is derived from the
  existing pinned `setupDraftsDir` metadata field, and no new column or table is
  added.
- No behaviour change for non-`env-setup` workflows: the staged root is only
  resolved for a `workflow:<id>` owner whose snapshot pins one.
