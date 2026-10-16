## Context

### What the family does today

| Piece | Path | Behaviour |
| --- | --- | --- |
| Family graph | `src/workflow/definitions/graphs/env-setup.ts` | `setup.author → setup.validate → setup.approval → setup.promote → core.completed`; validate→author and approval→author are the bounded loops. |
| Step behaviours | `src/workflow/steps/env-setup.ts` | enqueues `environment.setup-guard` (baseline/check), `environment.validate`, `environment.promote`; carries the subject (`workflowId`, `runId`, `app`, `repository`, `checkout`, `draftsDir`). |
| Step contracts | `src/workflow/definitions/steps.ts` | `setup.author` (agent), `setup.validate` (system, `environment.validate`), `setup.approval` (developer), `setup.promote` (system, guard+promote). |
| Pinned state | `src/workflow/runtime/engine.ts` (~1444) | pins `metadata.setupDraftsDir = <config>/.drafts/env-setup/<id>` and `setupPromotionSecret`; `src/workflow/schema.ts:508` already carries the field, so no schema change is needed. |
| Drafts module | `src/server/environment/setup-drafts.ts` | allowed prefixes, `listDraftEntries`/`listDraftFiles`, per-file diff vs the live file, `fingerprintDirectory` (write guard), `assertSetupDraftsDir` (pinned value untrusted on read). |
| Gate | `src/server/environment/setup-validate.ts` | structural checks (path, parse, discover, compile, OTel, host-port collision, `${VAR}`) plus a start of every drafted *run* target. No build, no test. |
| Promotion | `src/server/environment/setup-promote.ts` | locked, journaled, replayable copy of every drafted file with protected backups and full rollback; moves the drafts aside on success. |
| Effect handlers | `src/workflow/effect-runner.ts` (~2259–2550) | guard baseline/check, `validateSetupDrafts`, `promoteSetupDrafts`; `startSetupTarget` acquires the app for `workflow:<id>` and waits for the grant. |
| Overlay resolver | `src/server/integrations/services.ts:69` | `createWorkflowOwnerOverlayResolver` returns the pinned `setupDraftsDir` for the owner, so a workflow's starts resolve drafts first. |
| Discovery seam | `src/server/actions/discovery.ts:33-120` | `resolveConfigFilePath`/`configDirEntries`: the overlay applies *per file*, and only to a plain file. |
| Run starts | `src/server/runtime/instances.ts:1249` | resolves the owner overlay, discovers run targets with it, `selectTarget` picks the runtime/profile default. |
| Agent env surface | `src/server/environment/agent-routes.ts` | `list` (apps + compiled-registry targets + infra services), `acquire/stop`, build/test via `runAppBuildTestAction`. |
| Agent tools | `src/agent-host/environment-tools.ts`, `src/agent-host/environment-capability.ts` | `env_*` HTTP tools; capability from the in-process publication or the discovery record (`fix-env-tools-for-all-runs`). |
| Startup guard | `src/workflow/startup.ts:570` | refuses to start when the drafts directory of that workflow id already holds files. |
| Tests | `test/env-setup-{discovery,drafts,overlay,validate,approve,effects,promote,workflow}.test.ts` | cover the overlay, the structural gate, the promotion and the guard with doubles. |

### Evidence from the first real run

1. A drafted compose file resolving `../../infrastructure/compose/*.yml` failed inside
   `.drafts/.../infrastructure/compose/`; the author rewrote the file to fit the draft
   location, so what was tested is not what gets promoted.
2. Live `apps/build/*.Dockerfile` and `apps/compose/*-compose.yml` are symlinks into
   `~/devenv-config/...`; `docker build -f <config>/apps/build/x.Dockerfile` failed with
   `failed to read dockerfile: ... no such file or directory`, and
   `prepare-build-context` printed `sh: devenv-templates-...: No such file or directory`.
3. The gate never built and never ran a test target, so a draft whose default build
   fails reached the developer.
4. `env_list`/`env_build` for an `env-setup` run: `env_build`/`env_test` discover from
   `services.configDir` only (`runAppBuildTestAction` takes no overlay), and `env_list`
   lists the compiled registry's live targets — so "the drafts are what runs" held for
   `env_start` and not for the other tools.
5. Two build targets for one app/profile (Dockerfile + host-maven) with no stated
   default; `agentTarget` silently preferred the first default-profile candidate.

## Goals / Non-Goals

**Goals:**

- What the author runs, the gate runs and the developer promotes is one configuration
  layout: a complete staged configuration root in which `include:`, relative mounts and
  `docker -f` behave exactly as they will after promotion.
- The gate exercises the real developer path (discover → compile → default build →
  start with readiness → default test) before the developer is asked to approve, with
  bounded time, bounded output and honest `skipped:` reporting.
- Promotion is conflict-safe and reversible: no silent overwrite of a file the
  developer changed in the meantime, and a post-promotion smoke check that can restore
  exactly the previous files.
- The two production root causes (symlinked `-f` source, ambiguous default target) are
  fixed with regression tests that need no daemon, maven or network.

**Non-Goals:**

- Drafting `apps/definitions/*` or `libraries/definitions/*`: the app catalog is not a
  draftable prefix (`SETUP_DRAFT_PREFIXES`) and the process-wide `EnvironmentManager`
  catalog stays live. The staged root is applied to the *owner-scoped* reads: action
  discovery, compose/docker invocations, the owner's infra/target listing and the
  `env_*` surface.
- Publishing deletions: promotion adds and replaces files. A path the author deleted
  inside the staged root is reported as a finding and never promoted.
- Secrets authoring: `.env` and `providers/` stay human-owned and are only exposed
  read-only to the staged root; the report lists missing `${VAR}`s as today.
- Changing any store schema (`STORE_SCHEMA_VERSION` stays 6), the app slot model, the
  classifier, or a non-`env-setup` workflow's behaviour.
- Making the gate tolerant of a broken machine: a step the machine cannot run is a
  finding, not a pass (see Open Questions).

## Decisions

### D1. The staged root is the workflow's pinned directory plus a `root/` view

```
<config>/.drafts/env-setup/<workflowId>/       ← `metadata.setupDraftsDir` (unchanged value)
  root/                                        ← the staged configuration root (the only thing the author writes)
  base.json                                    ← the base snapshot taken at materialization
<config>/.drafts/env-setup/<workflowId>.promoted/  ← moved aside after a promotion (unchanged)
```

- `setupDraftsDir()` keeps returning the workflow state directory (so
  `assertSetupDraftsDir`, the startup leftover check and every pinned-value check keep
  working unchanged), and a new `setupStagedRoot(configDir, workflowId)` /
  `stagedRootOf(stateDir)` derives `root/`. **No new metadata field and no schema
  change** — the existing pinned JSON field is what the resolver consults.
- The owner overlay resolver returns the staged root when it exists and the state
  directory otherwise (a snapshot that predates this change, or a promoted workflow
  whose root was moved aside, therefore keeps today's behaviour).
- *Alternative rejected:* a separate top-level `<config>/.staging/...` location — same
  cost, a second root to sweep, and no reuse of the already-hardened pinned value.
- *Alternative rejected:* symlinking (or hard-linking) unchanged live files into the
  staged root — a draft write through a hard link would corrupt the live file, and
  symlinks are exactly the ambiguity the root exists to remove.

### D2. Materialization is a durable effect, idempotent, bounded, secret-safe

`environment.setup-stage` (`environment.setup-stage` effect kind, enqueued by
`setup.author.onEnter` *before* the guard's baseline), implemented in a new
`src/server/environment/setup-staged.ts`:

- Walks the live configuration with the fingerprint bounds (20 000 entries, depth 12)
  and copies every entry, preserving the relative layout. Exclusions:
  `.drafts`, `.backups`, `wiki`, `telemetry`, `snapshots`, and the server's
  discovery record.
  `.env` and `providers/` are exposed to the staged runs as **private read-only
  copies**: `.env` as a file and `providers/` as a directory of files, mode
  `0o400` inside the workflow's `0o700` state directory, never symlinks. A symlink
  is write-through, so a stray write from a drafted script would rewrite the live
  credential store before approval; a copy cannot. The promotion's
  configuration-relative prefix allow-list keeps them unpublishable, and the base
  snapshot records digests, never content.
  absolute so a deeper staged location cannot change what they point at.
- Files are created with their live mode, the staged root with `0o700`; the write
  guard keeps excluding the whole state directory by path, so the copy never reads as
  a change to the live configuration.
- Idempotent: when `base.json` exists and `root/` exists, the effect reports
  `already-staged` and does nothing (a re-claimed effect must never clobber the
  author's edits). The base snapshot records, per relative path, kind (`file`/`symlink`/
  `dir`), content digest and symlink target — the bytes of `base.json` hold digests,
  never secret content.

*Alternative rejected:* materialize at `workflow start` in `engine.ts` — the engine
pins metadata in one transaction and does no I/O; a partially materialized root would
have no retry.

### D3. Changed files are derived from the base snapshot

`stagedChanges(stateDir)` returns `{path, status: added|modified, kind}` by comparing
`root/` against `base.json`:

- Only the documented prefixes (`SETUP_DRAFT_PREFIXES`) are considered drafts.
- An entry whose digest equals the base entry's is unchanged and is not a draft; this
  is what keeps the 78 live symlinks under `apps/`/`infrastructure/` from being read as
  drafts.
- An entry that is a symlink whose target differs from the base, or any non-regular
  entry inside an allowed prefix, is a finding (`non-regular-file`) and is refused by
  the promotion, exactly as today.
- A base path that is missing (or now a directory) in the staged root is a finding
  (`staged-deletion`) stating that deletions are not published.
- The approval diff (`setupDraftChanges`/`setupDraftChange`), the promotion plan and
  the internal write-guard fingerprint consume this list, so their shapes are
  unchanged: `SetupDraftChange`, `SetupPromotionFile`, `LocalChange` rows.

### D4. Discovery resolves the staged root as a *root* overlay

`DiscoveryContext.configOverlay` keeps its meaning ("a second config directory whose
files shadow `configDir` per relative path"), but the staged root is complete and
contains the live symlinks. Two bounded changes in `src/server/actions/discovery.ts`:

- `resolveConfigFilePath` accepts the overlay entry when it is a plain file **or** a
  symlink (a directory still falls back to live); the "never run content the approval
  view does not show" property is preserved by D3's finding rule for *changed*
  symlinks, and the approval diff shows an added/replaced symlink as a change.
- `configDirEntries` returns a symlinked overlay entry too, so a symlinked live compose
  file resolves from the staged root.

Because the resolved `sourcePath` then lives inside the staged root, compose
`include:`/bind mounts and `docker build -f` resolve their relative paths inside a tree
that mirrors the real one. `docker compose -f <staged>/apps/compose/x.yml up -d` needs
no `--project-directory` change: compose already uses the compose file's directory as
the project directory; the design adds a test that a compose draft including
`../../infrastructure/compose/network.yml` starts from the staged root, so this
assumption is proven, not asserted.

- `env_build`/`env_test` gain the overlay they lack today: `AgentActionRequest` carries
  an optional `configOverlay`, `runAppBuildTestAction` passes it to
  `discoverActionTargets`, and the agent-env route resolves it through the same owner
  overlay resolver as `env_start`.
- `env_list` resolves the owner's config-root view for the app/infra definition reads it
  does for that owner, and marks each target with `staged: true` when it resolved from
  the staged root, plus `default: true` (or `defaultAmbiguous: true`) per action.

### D5. The gate runs the real path, from the workflow's own capability

`setup.validate` keeps every structural check and adds an execution phase, reported per
step so the author and the developer read the same list:

`discover → compile → build (default) → start (default, readiness) → test (default, when one exists)`

- The steps are executed through the *owner-scoped HTTP surface the agent itself uses*
  (`/api/v1/agent-env/build|test` with the `workflow:<id>` capability and the owner
  overlay), so "what the gate ran" is literally the same code path as `env_build`,
  `env_test` and `env_start` — not a second build implementation. On success the app is
  released again unless the workflow keeps it.
- "Drafted or affected" targets: the app under setup's drafted run/build/test targets,
  plus every *modified* shared infrastructure definition, which must at least parse
  (`docker compose -f <staged> config -q`; a missing docker CLI is a `skipped` finding).
- Bounds: per-step timeout (build 30 min, start 10 min, test 30 min, wall-clock budget
  for the whole gate), bounded log tail per step (last 40 lines / 8 KB), and the log
  tail is what the author's next round and the approval payload carry.
- The report gains `steps[]` (`{targetId, action, step, status: ok|failed|skipped,
  exitCode, durationMs, logTail, targetsSeen[]}`) and `defaults`
  (`{action, targetId}`); new findings `build`, `test`, `no-default-target`,
  `no-test-target`, `skipped`. `ok` is false when any *required* step failed, was
  skipped or had an ambiguous default.
- The approval step opts into the validate report (`carriesOutputContext: true`), so the
  developer sees the commands, their results and the default target per action. Today
  the report is dropped on the floor at that transition.
- *Alternative rejected:* execute the build through a fresh in-process action engine in
  the effect runner — it would duplicate the developer's path and drift from it.

### D6. Root causes

- **Symlinked `-f` source.** `dockerBuildSteps` (`src/server/actions/target-compile.ts`
  ~1171) passes `-f target.sourcePath`. BuildKit reads the Dockerfile relative to the
  build context when the path escapes it through a symlink. Fix: pass
  `fs.realpathSync(sourcePath)` (falling back to the lexically resolved path when the
  link is broken, with the reason reported), and apply the same resolution where a
  compose `-f` path is built (`target-compile.ts` 442/448/491/766, `instances.ts`
  compose start, `routes.ts` 1303). Regression test: a temp configuration whose
  `apps/build/<app>-build.Dockerfile` is a symlink to a file outside the build context,
  with a stub `docker` on `PATH` that records argv and fails when `-f` names a symlink
  escaping the context. No daemon, no network.
- **`prepare-build-context` noise.** The `sh -c` command redirects stderr but `ls -1A`
  of a missing `templates/` directory still reaches the log; fix it to test the
  directory first (`[ -d ... ] && ls -1A ... || :`), keeping the marker semantics, and
  cover it with a test asserting the step's stderr is empty.
- **Default target determinism.** `agentTarget` (`routes.ts`) and `selectTarget`
  (`instances.ts`) keep preferring the `default` profile, and *within* the default
  profile they no longer silently take the first candidate: several candidates is an
  error naming every candidate id. `env_list` marks the resolved default per action and
  `agentic-coding`'s env-setup instruction requires the author to state the default
  target per action in the report. The gate reports the same choice, so a draft with two
  default-profile build targets cannot silently pass.

### D7. Promotion conflicts, smoke check and rollback

- `promoteSetupDrafts` gains a `changed` list from D3 plus a conflict check: before
  writing a path whose status is `modified`, the live content must equal the base
  snapshot digest. Otherwise the path is refused with `conflict` and the result names
  it (`{ok: false, conflicts: [...]}`); nothing is written, the promotion does not roll
  back (nothing was written), and the step reports the conflict to the developer.
- New step `setup.smoke` (system, `environment.setup-smoke`) after `setup.promote`:
  re-resolves the app's default run target against the **live** configuration (the
  staged root has been moved aside), starts it through the slot controller for
  `workflow:<id>` and waits for readiness; it re-runs the default build only when the
  promoted build definition's digest differs from the digest the gate recorded for it
  ("the gate already proved an identical build"), otherwise it reports
  `build: skipped (proven identical by the gate)`.
- On failure `setup.smoke` transitions `failed` to a developer step `setup.smoke.review`
  whose actions are `rollback-promotion` and `accept-smoke-failure` (offered only once
  the smoke report is present, so a developer cannot race the running check):
  - `rollback-promotion → setup.rollback` (system, `environment.setup-rollback`) runs
    the exported `rollbackPromotion()` — the same backup/journal machinery, driven by
    the promotion journal of this run — restores the staged root from `.promoted`,
    reloads the catalog, and proves every restored file matches its backup digest; its
    completion returns to `setup.author` (bounded loop) with the rollback report as
    context.
  - `accept-smoke-failure → core.completed`, recording the failed smoke check in the
    workflow's output.
- Nothing here can run before approval: the smoke step is only reachable from
  `setup.promote`'s success edge, which is only reachable from the approval edge.

### D8. Teardown and sweep

`core.closed`'s existing `environment.teardown` stays the owner-bound release. A new
`environment.setup-cleanup` effect (enqueued at `setup.promote` completion and at
`core.closed`) removes the workflow's staged root and its `.promoted` sibling, keeps
`.backups/env-setup-<id>/` (the rollback evidence) and never removes another workflow's
state. The startup leftover check keeps refusing a start whose state directory already
holds files, and its message names the stale directory; a sweep for state directories
whose workflow no longer exists in the store is part of the change (bounded, logging
what it removed).

## Risks / Trade-offs

- **Disk usage**: a full copy of the configuration per running `env-setup` workflow →
  the exclusion list plus a bounded walk, materialization reports the copied entry
  count and byte total in the step report, and the start refuses a configuration larger
  than a configured bound instead of filling the disk.
- **Secrets**: the staged root holds private read-only *copies* of `.env` and
  `providers/` (mode `0o400`, inside the workflow's `0o700` state directory, never
  symlinks — a symlink is write-through into the live store) → `base.json` records
  digests rather than content, `SETUP_DRAFT_PREFIXES` keeps them unpublishable, and
  tests assert they are copies (not symlinks), that no secret value reaches the
  snapshot, and that a symlink *inside* an exposed entry is copied rather than
  recreated.
- **Symlink behaviour changes between the staged root and the live tree** → the staged
  symlinks are absolute, so they point exactly where the live ones point; both a
  symlinked Dockerfile and a symlinked compose file have their own test.
- **A stale staged root after a crash** → materialization is idempotent, start refuses
  leftovers naming the directory, and the sweep removes state for workflows the store no
  longer knows.
- **Concurrency**: two `env-setup` workflows of different apps both stage and both take
  their own app slot; the existing promotion lock (`<config>/.backups/env-setup-promote.lock`)
  still serializes promotions, and the staged roots are per workflow id, so neither can
  read the other's drafts.
- **The gate gets much slower** (a real build and a real test) → per-step timeouts, a
  total gate budget, bounded log tails, and the loop budget stays five rounds; the
  report says which step consumed the budget.
- **`skipped` steps fail the gate** → a laptop without docker can never reach the
  approval gate; the alternative (approve with a visible skip) is recorded as an open
  question for the developer, and the skip is always named in the report and in the
  author's next round either way.
- **`env_build`/`env_test` changing to resolve the overlay** → non-`env-setup` owners
  resolve no overlay, so their behaviour is unchanged; the change is guarded by the
  resolver returning nothing for every other owner.

## Migration Plan

1. Land the staged-root module and the overlay/effect wiring behind the pinned-value
   rule: a snapshot with no `root/` keeps today's per-file overlay behaviour, so an
   in-flight workflow started by an older build is not broken.
2. Land the gate, the smoke/rollback steps and the graph changes together, because the
   new effect kinds and step outcomes are validated at reduction time.
3. Land the root-cause fixes (D6) first if ordering matters for the acceptance
   scenario: the staged root's symlinked Dockerfile only builds once `-f` resolves the
   real path.
4. Rollback strategy for a promoted configuration is the existing promotion backup plus
   the new `rollbackPromotion()`; nothing in this change removes or rewrites those
   backups.

## Open Questions

- A machine that cannot run a required step (no docker daemon, no maven): fail the gate
  with a `skipped` finding (design default) or park for the developer with the skip
  visible?
- Does the developer want the "keep the promotion despite a failed smoke check" action
  at all, or should the only choices be roll back and re-author?
- Should a modified shared infrastructure definition be *started* by the gate (compose
  up of the infra project) in addition to being parsed with `docker compose config -q`?
