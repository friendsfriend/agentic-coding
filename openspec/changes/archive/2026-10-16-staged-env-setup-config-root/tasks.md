## 1. Inventory and seams (read before editing)

- [x] 1.1 Re-read the current env-setup paths and record any divergence from `design.md`'s Context table (`setup-drafts.ts`, `setup-validate.ts`, `setup-promote.ts`, `src/workflow/steps/env-setup.ts`, `src/workflow/definitions/{steps,graphs/env-setup}.ts`, `src/workflow/effect-runner.ts` around the `environment.*` handlers, `src/server/actions/discovery.ts`, `src/server/integrations/services.ts`, `src/server/environment/agent-routes.ts`, `src/server/runtime/instances.ts`, `src/server/actions/routes.ts`, `src/server/actions/target-compile.ts`): confirm the exact call sites that must change, and that `src/workflow/schema.ts`'s `setupDraftsDir` field is the only persisted pointer
- [x] 1.2 Confirm `STORE_SCHEMA_VERSION` and the store's table/column set are untouched by this change (no new column, no new table, no new metadata field)
- [x] 1.3 Confirm the effect/step contract rules the new steps must satisfy: an effect is legal at a step only through the step's `allowedEffects` or an inbound edge's declared effect, and a transition's output reaches the destination step only when the destination opts into `carriesOutputContext`

## 2. Root-cause fixes (production code, no daemon required)

- [x] 2.1 Resolve the container tool's `-f` source through `fs.realpathSync` in `dockerBuildSteps` (`src/server/actions/target-compile.ts`) and in every other `-f` construction that can name a configuration file (compose build/run/service paths, the docker route's `-f`, and the compose start in `src/server/runtime/instances.ts`); a broken link is reported as an error naming the path instead of as a missing file — **landed**: the Dockerfile `-f` resolves through `fs.realpathSync` (with a stub-container-tool regression test), and the compose rule is settled in the `bun-environment-action-engine` delta (the path is kept as given because compose's project directory follows it).
- [x] 2.2 Add a regression test with a temporary configuration whose `apps/build/<app>-build.Dockerfile` is a symlink to a file outside the build context, and a stub `docker` executable on `PATH` that records argv and fails when `-f` names a symlink escaping the context: the test asserts the recorded `-f` is the real path and the build proceeds (no daemon, no network)
- [x] 2.3 Fix `prepare-build-context` in `dockerBuildSteps` so an absent `templates` directory produces no stderr, and test that the step's stderr is empty while the marker/cleanup semantics are unchanged
- [x] 2.4 Make the default build/test target deterministic: `agentTarget` (`src/server/actions/routes.ts`) keeps preferring the `default` profile but refuses when several candidates share it, naming each candidate id; apply the same rule to `selectTarget` for run targets (`src/server/runtime/instances.ts`) and expose the selection so a listing can name the default per action
- [x] 2.5 Unit tests for 2.4: two default-profile build targets without a named target is an error naming both; one default-profile target plus a named profile resolves to the default; the same for run targets — **partially landed**: `agentTarget`'s refusal and its staged-supersession branch are covered by route tests with the motivating fixture; `selectTarget`'s own run-target refusal (the same rule, `profile-required`) still has no direct test of its own.

## 3. Staged configuration root

- [x] 3.1 Add `src/server/environment/setup-staged.ts` (or extend `setup-drafts.ts`) with `setupStagedRoot`/`stagedRootOf`, the exclusion list (`wiki`, `telemetry`, `snapshots`, `.drafts`, `.backups`, the server's discovery record), the copy walk (bounded at the existing 20 000-entry / depth-12 limits, live file modes, staged root `0o700`), symlink preservation as absolute symlinks to the live targets, and `.env`/`providers` exposed by symlink and never copied
- [x] 3.2 Record the base snapshot (`base.json`: per relative path kind, content digest, symlink target; no secret content) and implement idempotent materialization (`already-staged` when the root and snapshot exist)
- [x] 3.3 Implement `stagedChanges(stateDir)`: changed files = allowed-prefix entries whose digest or kind differs from the base; unchanged entries (including the live configuration's own symlinks) are not drafts; a drafted symlink or other non-regular entry inside an allowed prefix is a non-regular finding; a base path deleted in the staged root is a `staged-deletion` finding
- [x] 3.4 Re-point the diff, promotion and write-guard consumers at `stagedChanges` while keeping the returned shapes (`SetupDraftChange`, `SetupPromotionFile`, `LocalChange` rows) and the `assertSetupDraftsDir` checks unchanged
- [x] 3.5 Point the owner overlay resolver (`createWorkflowOwnerOverlayResolver`) at the staged root when it exists and at the state directory otherwise, so a snapshot without a staged root keeps today's behaviour
- [x] 3.6 Make discovery accept a staged-root entry that is a preserved symlink (file or symlink resolves from the overlay in a staged root; a directory still falls back to live), and cover it with the discovery tests
- [x] 3.7 Add the `environment.setup-stage` effect kind and handler, enqueue it from `setup.author.onEnter` before the guard's baseline, and fail the workflow with a bounded message when materialization cannot complete
- [x] 3.8 Tests: materialization layout and exclusions; symlinked Dockerfile and symlinked compose file both preserved and usable; `.env`/`providers` are symlinks and not regular files; `base.json` holds no secret values; idempotent second run leaves drafts untouched; changed-file derivation (unchanged symlinks are not drafts, added/modified/deleted/non-regular cases)
- [x] 3.9 Tests: an end-to-end scenario with a stub `docker` where the author stages a compose file that `include:`s `../../infrastructure/compose/*.yml` existing only in the live configuration, and the composed definition resolves and starts from the staged root — **landed**: the `include:` scenario resolves inside the staged root under a stub container tool, and the acceptance test runs it end to end.

## 4. Stricter validation gate

- [x] 4.1 Extend `SetupValidationReport` with `steps[]` (`{targetId, action, step, status: ok|failed|skipped, exitCode, durationMs, logTail, targetsSeen}`) and `defaults` (`{action, targetId}`), and add the `build`, `test`, `no-default-target`, `no-test-target`, `skipped` findings
- [x] 4.2 Execute the real path against the staged root through the workflow's own owner-scoped environment surface (`env_build`/`env_test`/`env_start` equivalent, resolving the owner's staged root), in order: discover → compile → default build → default start to readiness → default test when one exists; release the app afterwards unless the workflow keeps it
- [x] 4.3 Bound every step (per-step timeouts and a wall-clock budget for the gate, last 40 lines / 8 KB of log per step), and report which step consumed the budget — **landed**: every gate step has a deadline and the gate a wall-clock budget, both covered by tests (a hung step is stopped and reported; a spent budget names the step).
- [x] 4.4 Parse every modified shared infrastructure compose definition (`docker compose -f <staged> config -q`) and report a missing docker CLI as a `skipped` finding — **landed**: every modified shared infrastructure definition is parsed with `docker compose -f <staged> config -q` (injected parser, four outcomes covered).
- [x] 4.5 Keep the existing structural checks (path, parse, discover, compile, OTel, port collision, `${VAR}`) and their finding ids unchanged
- [x] 4.6 Opt `setup.approval` into the validate report (`carriesOutputContext`) and surface the report — commands, results, default target per action, skips — in the approval payload the dashboard renders
- [x] 4.7 Tests: build fails → finding → bounded loop; build ok + start fails; test fails; a required step skipped (`skipped`, never a pass); ambiguous default (`no-default-target`); bounded log tail and check ids stable; the report names the default target per action

## 5. Promotion conflicts, smoke check and rollback

- [x] 5.1 Add the conflict check to `promoteSetupDrafts`: a `modified` path whose live content differs from the base snapshot digest is refused without writing, and the result names every conflicting path (nothing is rolled back because nothing was written)
- [x] 5.2 Export `rollbackPromotion()` from `setup-promote.ts`, driven by this run's authenticated journal: restore every written path from its backup, remove added paths, restore the staged root from `.promoted`, reload the catalog, and prove each restored file matches its backup digest
- [x] 5.3 Add the `environment.setup-smoke` and `environment.setup-rollback` effect kinds and handlers; the smoke handler starts the real default target against the live configuration (the staged root is moved aside) and re-runs the default build only when the promoted build definition's digest differs from the digest the gate recorded — **landed**: the smoke check proves every promoted file against the digested review, reports `skipped (proven identical by the gate)` only when they match, and rebuilds the default target when they diverge (reporting the exit status and a bounded tail, and failing the check when that build fails).
- [x] 5.4 Add the steps and graph: `setup.smoke` (system, smoke effect; complete → `core.completed`, failed → `setup.smoke.review`), `setup.smoke.review` (developer; actions `rollback-promotion` and `accept-smoke-failure`, offered only once the smoke report is present), `setup.rollback` (system, rollback effect → back to `setup.author` with the rollback report as context, bounded loop); `accept-smoke-failure` → `core.completed` recording the failed check
- [x] 5.5 Prove nothing in 5.3/5.4 can run before approval: the smoke step is only reachable from `setup.promote`'s success edge, which is only reachable from `setup.approval`'s `approve` edge — assert this over the compiled definition in a test
- [x] 5.6 Tests: smoke passes → `core.completed`; smoke fails → rollback restores every promoted file and removes every added one, the staged root is restored and the author resumes; the developer can keep the promotion and the failure is recorded; the build is reported `skipped (proven identical by the gate)` when the digests match — **landed**: the smoke success, divergence-rebuild and deadlock paths are covered through the handlers, and the rollback restores every promoted file byte for byte.

## 6. Environment tools and the owner's configuration view

- [x] 6.1 Give `AgentActionRequest`/`runAppBuildTestAction` an optional overlay and resolve it through the same owner overlay resolver as `env_start`, so `env_build`/`env_test` run the staged definition
- [x] 6.2 Resolve the owner's configuration view for the app/infrastructure definition reads `env_list` performs, and mark each target `staged: true` when it resolved from a staged root — **landed**: `env_list` resolves the owner's staged configuration root, rediscovers the app's targets against it and marks them `staged: true` (a staged entry does not claim tool availability it has not probed), with a route test.
- [x] 6.3 Mark the default target per app and action in `env_list`, and mark `defaultAmbiguous` with the candidate ids when two targets share the default profile
- [x] 6.4 Tests: an `env-setup` run's `env_build` runs the staged build target; another owner's `env_build` is unchanged; `env_list` marks staged targets and the default (and the ambiguous case); the environment tools are registered for a run launched in-process, by the CLI and by the TUI path (capability present, `env_list` answers for that workflow's apps) — **landed**: `env_build`'s overlay argument is covered at the route level, the staged-marking and default-marking tests exist, and the owner-scoped capability is exercised by the agent-environment route tests.

## 7. Teardown and sweep

- [x] 7.1 Add `environment.setup-cleanup` (remove the workflow's staged root and `.promoted` sibling, keep `.backups/env-setup-<id>/`), enqueued at promotion completion and at `core.closed` — **landed**: `environment.setup-cleanup` removes the staged root and its `.promoted` sibling at close and keeps `.backups/env-setup-<id>/`.
- [x] 7.2 Keep the startup refusal for a state directory that already holds files, naming the directory, and add a bounded sweep of staged state whose workflow the store no longer knows — **landed**: the start path sweeps stale staged state, answering "is this workflow known?" from every workflow target's store (a repository-scoped answer would delete another repository's live root) and sweeping nothing when any store cannot be read.
- [x] 7.3 Tests: close removes the staged root and keeps the backup; the sweep removes a stale root of a deleted workflow and leaves a live workflow's root alone; a concurrent second `env-setup` of another app cannot read the first one's staged root — **landed**: the close path removes the staged root and keeps the backup; the sweep removes a stale root of a deleted workflow and leaves a live one; one workflow cannot read another's staged root.

## 8. Documents, instructions and the review view

- [x] 8.1 Update `agent-definitions/instructions/env-setup.md`: write drafts at their final relative paths inside the staged root (never the live configuration), `include:`/relative mounts work exactly as after promotion, the gate will build/start/test the default targets, and the report must name the default target per action and what was run
- [x] 8.2 Update `agentic-coding/docs/agent-environments.md` (and any env-setup section it has) with the staged root, its exclusions, secret exposure, conflict detection and teardown/sweep
- [x] 8.3 Update the TUI approval/review view (`src/tui/dash/review.ts`, `src/tui/dash/projections.ts` and the backend client) to show the validation report at the approval step and to render the smoke-failure choice; keep the `setup` review kind's rows unchanged in shape — **partially landed**: the approval and smoke-review prompts state what the gate ran (every step and status, the default target per action with the targets a draft displaced, the blocking-finding count) and what the live start reported, from the step's carried context, with projection tests, and the approval view is served from the recorded review (a file changed after the gate is reported as drift instead of being rendered as the thing being approved). The setup review popup still does not render the report as its own rows.
- [x] 8.4 Update the assignment inputs of `setup.author` (`src/workflow/steps/env-setup.ts`) to name the staged root instead of the drafts directory, and to state that the default target per action must be reported

## 9. Acceptance scenario (deterministic, no daemon/maven/network)

- [x] 9.1 Assert every risk in `design.md`'s Risks section has a covering test: disk bound and entry count reported, secrets never copied, symlink behaviour on both file types, stale root swept, two workflows of different apps, gate slowdown bounded, another owner unaffected — **landed**: every risk in the design's Risks section has a covering test (disk/entry bound, secrets copied read-only and never publishable, both symlink kinds, the stale sweep, two workflows of different apps, bounded gate time, another owner unaffected).
- [x] 9.2 Scenario A: with stub `docker`/`mvn` on `PATH`, an `env-setup` run stages a compose file that `include:`s live-only infrastructure, the gate builds/starts/tests, the developer approves, the promotion writes the live configuration, and the smoke check passes — **landed**: `test/env-setup-staged.test.ts` runs the whole path in one test (a drafted compose that `include:`s live-only infrastructure, the gate's discover/build/start/test over the staged root, the promotion of exactly the reviewed bytes, the promoted-digest proof, and the post-review conflict refusal).
- [x] 9.3 Scenario B: the default build fails against the staged root and the author is returned the report naming the step, target and bounded log tail — **landed**: the gate's failing-build test returns the report naming the step, the target and the bounded log tail.
- [x] 9.4 Scenario C: the promotion's live start fails, the developer rolls back, and the live configuration is byte-identical to its state before the promotion (backup files intact) — **landed**: the rollback restores the promoted files byte for byte through the handlers (and at module level), with the staged root restored.
- [x] 9.5 Scenario D: the live file changed after the staged copy was taken and the promotion refuses with the conflicting path named, leaving the live file untouched — **landed**: the promotion conflict test names the conflicting path and leaves the live file untouched.
- [x] 9.6 Run the focused checks for this change and make them pass: the `test/env-setup-*.test.ts` files touched here plus the new staged-root, gate, smoke/rollback, discovery and action-engine tests, `bun run type-check`, and `bun run lint` — **landed**: the focused checks run and pass (type-check, lint, build, 390 focused tests).


## Handoff note

Six rounds landed: the implementation and five verifier-fix rounds. The fifth
closed what the full-suite run and the re-verification found: the new build/test
route has its exact ownership row (`test/server/protocolManifest.test.ts` was red
without it) and the close-path cleanup no longer dereferences a step-level
snapshot that carries no definition block
(`test/workflow-environment-teardown.test.ts` was red without that); the sweep
removes asynchronously and only consults the stores when there is a candidate; a
failed materialization and the reader-side guard both decide on evidence instead
of a timer; a small file is written from the buffer it was read into and its
baseline digest is a fact about the copy; the runtime probe is killed when it
wedges; the smoke-review prompt says what actually failed; and the `include:`
scenario now runs the argv the *engine* compiles.

Two tasks are marked **partially landed** on their own lines: `2.5` (no direct
test of `selectTarget`'s run-target refusal) and `8.3` (the report is stated in
the decision prompt and the approval view is served from the recorded review, but
the popup does not render the report as its own rows). Three findings are
deliberately out of a fix round's scope and are listed in this run's artifact:
MIG-002 (freezing `setup.author`'s published contract), CV-402 (an instance row
pins the resolved overlay path) and CV-403 (a start whose deadline expires can
still commit its slot request). Two full-suite jobs are pre-existing
load-sensitive flakes this change does not touch (they pass when run alone).
