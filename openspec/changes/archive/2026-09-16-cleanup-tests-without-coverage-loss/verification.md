# Verification evidence: cleanup-tests-without-coverage-loss

Change-local evidence for the coverage-preserving test cleanup. Every removal
must name the surviving detector (or its test-local/incidental-only rationale);
every repaired detector must show a focused fault probe (baseline pass →
injected fault fails → restored code passes).

## 1. Baseline

Environment: Bun **1.4.2** (`packageManager` pins `bun@1.3.14`; the local
runtime is newer). Commands run from `agentic-coding/`.

| Command | Result | Count | Elapsed | Skips |
| --- | --- | --- | --- | --- |
| `bun run test` | PASS | 180/180 test files, **1714** tests | 58.88 s | 0 reported |
| `bun run test:devenv` | PASS | 41 files, **171** tests (418 `expect()` calls) | 0.94 s | 0 reported |

Working tree at start: clean (`git status --short` empty, HEAD `ff40d91`).
Inventory: 221 files / 68,568 lines in the audit → **180 files / 63,757 lines**
under `test/` now, plus 41 files / 4,811 lines under `packages/devenv`. The
audit's numbers are stale, not a target.

Grouping (audit clusters, no files moved):

- `test/` root: 98 files — workflow 37, actions 13, runtime 12, integration 10,
  environment 6, config 4, server 2, lifecycle 2, tui 2, other 10.
- `test/dash/`: 38, `test/otel/`: 25, `test/app/`: 19.
- `packages/devenv/`: 41.

### Process-tree timeout recheck (task 1.2)

The audit's intermittent `actions-script-runtime.test.ts` process-tree timeout
did **not** recur in this baseline run. The assertion was not weakened.

### Skip accounting (baseline finding)

`scripts/test.ts` parses only `Ran (\d+) tests? across` from Bun's summary; it
does not read Bun's `skipped` count. Four opt-in runtime smoke cases
(`test/runtime-smoke.test.ts`) log `skip: …` and `return`, so they are counted
as executed passes today. Task 6.3 addresses this.

## 2. Digest compaction evidence (tasks 2.1–2.3, row L1)

Shape of the pre-cleanup fixture: 489 definitions × 3,562 step-digest entries
over **15 distinct step ids**, each step id carrying exactly **one** digest, and
**16 distinct step sets**. `toEqual` compares the definitions array in order, so
definition order (`openspec-full` → … → `wiki-comments`) and every
(id, version, digest, steps) tuple is still asserted.

Compact fixture: shared literal `STEP_DIGESTS` + 16 indexed `STEP_SET_n`
literals + per-definition `{ id, version, digest, steps: STEP_SET_n }`.
`expectedDefinitions()` rebuilds the original `stepDigests` records from those
literals only — no value comes from `registerBuiltins()`.

| Measure | Before | After | Δ |
| --- | --- | --- | --- |
| Fixture block | 10,554 lines / 404,090 B | 3,165 lines / 77,224 B | −70 % lines, −81 % bytes |
| `test/workflow-steps.test.ts` | 11,351 lines | 4,002 lines | −64.7 % |

Equality proof (run **before** the repeated block was replaced): a one-off
`test/zz-compaction-proof.test.ts` held the original literal as
`ORIGINAL_DEFINITIONS` next to the compact fixture and asserted
`expectedDefinitions()` deep-equals it.

```
(pass) compact fixture reconstructs the complete original expectation [0.45ms]
 1 pass, 0 fail, 1 expect() calls
```

The proof file was deleted after recording. Focused suites
(`workflow-steps`, `workflow-registry`, `workflow-migration`,
`workflow-runtime`) passed: **83 pass / 0 fail**.

### Probes (isolated, on the real retained test)

Mutation applied to `test/workflow-steps.test.ts`, focused test run, file
restored from backup. Baseline before/after: **22 pass / 0 fail**.

| Probe | Mutation | Result |
| --- | --- | --- |
| missing identity | dropped final `wiki-comments` v220 definition | 1 fail (`preserves every registered definition and step digest`) |
| changed digest | flipped last hex digit of one definition digest | 1 fail |
| changed step association | removed `core.triage` from `STEP_SET_0` | 1 fail |
| extra identity | duplicated final definition entry | 1 fail |

Restored file verified byte-identical to the backup (`diff -q`); `biome check`
reports no fixes for the file.

## 3. Repaired behavioral checks (tasks 3.1–3.4, rows L2–L4, L6–L8)

### `test/app/pagesRender.test.tsx` (task 3.1)

Three manufactured outcome pushes removed and replaced with real production
input through `t.mockMouse.click` on the widget the frame shows (new `locate()`
helper):

- home page: click on the `Observability` row drives the production
  `onSelectIndex` handler (`selected()` becomes 1). The old
  `opened.push(entries[selected()].route)` is gone; opening a selection is
  asserted by `appShellMount.test.tsx` and
  `pageNavigation.test.tsx` (`Ctrl+P` → type → `Enter` → breadcrumb).
- category page: push removed; the render assertions stay.
- breadcrumbs: click on the first rendered ancestor (`Home`) asserts
  `onNavigate` receives that ancestor's route.
- location picker: click on the filtered `Metrics` row asserts `onAccept`
  receives `{ page: "observability.metrics" }`, and the production
  `filterPickerEntries` result is asserted to agree with the clicked row.

Unique rendering checks kept: one-row breadcrumb collapse at width 40, no inner
`1-4` tab row, picker search re-render.

### Modal positioning (task 3.2, rows L6/L7)

`test/dash/modalCentering.test.ts` (hand-built `BoxRenderable` overlay) is
**deleted**. Its guarantee now has a production detector in
`test/dash/sharedPrimitives.test.tsx`:
`dashboard modal stays terminal-centered beneath offset shell chrome` renders the
real `DashGenericModal` inside header + tab bar + status bar chrome and asserts
the dialog's first content row is 7 — `(24 − 12) / 2 + 1` — and that the same
dialog renders on the same row with no surrounding layout. A content-relative
placement would give row 9; the test asserts those two rows differ. The suite's
stacking, lifecycle, and selection-copy checks are untouched.

### Cycle / payload claims (task 3.3, rows L7/L8)

- `test/otel/topologyStore.test.ts`: the misleading "detects cycles gracefully"
  case (a single loaded span, second span built and discarded) is replaced by a
  genuine service cycle — each service's span parented by a span of the other —
  asserting both edges (`svcA→svcB`, `svcB→svcA`) and that both services fall
  back to layer 0 in the layout. A same-service parent link is asserted to
  create no edge and one service.
- `test/otel/otlp-grpc.test.ts`: "handles oversized payload gracefully" renamed
  to "refuses nullish spans", with a comment pointing at the real byte cap.
- **Missing detector added:** the 5 MB receiver cap
  (`src/tui/otel/receiver/index.ts`) had no test. `test/server-telemetry.test.ts`
  now posts a 5,100,000-byte body to the server-owned OTLP HTTP receiver and
  asserts `413` with `"payload too large"` and that the sink received nothing.

### Fault probes (task 3.4)

Each mutation applied to production source in isolation, focused suite run, then
restored from backup. Baselines: `pagesRender` 5/5, `sharedPrimitives` 12/12,
`server-telemetry` 7/7, `topologyStore` 7/7, `otlp-grpc` 8/8.

| Fault | Focused suite | Expected failure | Observed |
| --- | --- | --- | --- |
| `LocationPicker` `onAccept` call removed | `app/pagesRender.test.tsx` | picker case fails | `(fail) the location picker searches and jumps to a sibling destination` |
| `BreadcrumbRow` `onNavigate` call removed | `app/pagesRender.test.tsx` | breadcrumb case fails | `(fail) breadcrumbs render ancestors and navigate to the clicked one` |
| `<Portal>` removed from `GenericModal` | `dash/sharedPrimitives.test.tsx` | centering case fails | `(fail) dashboard modal stays terminal-centered…`, received row **9** (content-relative) |
| 5 MB guard removed from receiver `body()` | `server-telemetry.test.ts` | oversized case fails | `(fail) server-owned receivers route OTLP HTTP spans into the sink`, received **400** |

After restoring source, `git diff --stat src/` is empty and the five focused
suites pass **39 pass / 0 fail**.

## 4. Architecture guard repair (tasks 4.1–4.3, rows L9, L11)

### Environment ownership now reads the source graph (tasks 4.1/4.2)

The regex guard was nearly vacuous. The pre-cleanup pattern
`/content from "\.\.?\/.*environment\/(state-store|manager|private-api)\.ts"/`
requires the literal text `content from "` immediately before the specifier, so an
ordinary `import { … } from "../server/environment/state-store.ts"` never
matched. Measured on a mutated real module: **old regex match: false**.

`environmentOwnershipOffenders(root)` now walks `buildSourceAnalysis(root)` and
reports resolved edges from `workflow/**` and `tui/otel/**` into
`server/environment/{state-store,manager,private-api}.ts`. Edges are read from
the TypeScript AST, so binding names, re-exports, type-only references, and
literal dynamic/require forms are all edges; offenders carry source, position,
form, and resolved target. Composition-root clients (`src/server/**`) are out of
scope by construction — three of the four real importers are `server/*`.

Real-source probe (added then removed):

```
src/workflow/registry.ts line 1: import { createEnvironmentStateStore } from "../server/environment/state-store.ts";

(fail) no workflow or telemetry module depends on the environment internals
+  "workflow/registry.ts:1:45 static import of server/environment/state-store.ts"
old regex match in mutated file: False
```

Fixture coverage in the same suite uses a temp root with stub environment
modules and asserts one offender each for named import, re-export, type-only
import, literal dynamic import, and literal `require`, while a clean workflow
module and a `server/app.ts` composition-root client stay unlisted.

### Consolidation (task 4.3)

Removed the duplicate `src/workflow has no import cycle` test from
`test/workflow-module-import-cycles.test.ts`: it called the same graph builder
and cycle finder as `findRuntimeCycle(SRC_ROOT)` in
`test/workflow-source-layer-boundaries.test.ts`, over a strict subset of the same
tree. Equivalence probe: a real two-file cycle (`zz-cycle-probe-a/b.ts`) added
under `src/workflow` made **both** scans fail; after deleting the subset scan the
src-wide scan still failed, and with the probe removed both suites pass. The
suite keeps (and now documents) the distinct parent-barrel rule, which holds
whether or not the edge forms a cycle.

Retained unchanged: layer/purity checks, view/backend isolation, unresolved
runtime targets, Effect composition-root checks, obsolete-shim checks, the
single-environment-database-owner scan, and the real cross-database isolation
test that runs `createEnvironmentAuthority` against a temp home and asserts the
pre-existing workflow and telemetry stores are byte-identical afterwards.

## 5. Proven redundancy removals (tasks 5.1–5.4)

### Test-local scaffolding (task 5.1)

| Removed | Rationale | Surviving detector |
| --- | --- | --- |
| `test/actions-scripts.test.ts` `shape` helper + "the shape helper drops absent fields only" | helper was referenced **only** by that self-test; no product guarantee | production assertions in the same file compare real discovery output; 20 → 19 tests |
| `test/actions-discovery.test.ts` `caseNamed` helper + "caseNamed reports a missing case" | helper was referenced only by that self-test | `targets.map(shape)` comparison against the Go fixture stays; 24 → 23 tests |
| `test/dash/projections.test.ts` duplicated `phaseAgeHours`/`countVerifierFindings` calls and the `requiredUserActionFor` self-comparison | the second call in each pair repeated identical inputs; `planAgain` was compared to a `plan` built the same way | single `phaseAgeHours` assertion kept; `countVerifierFindings` covered by `test/dash/data.test.ts` ("verifier finding counts preserve zero severities", superset input + empty case); `requiredUserActionFor`'s real output asserted at `test/dash/data.test.ts:526-537` (`plan-review` key/title/items); test renamed to "projections compute from their explicit inputs" |

The `shape` helper in `test/actions-discovery.test.ts` is load-bearing (`targets.map(shape)`) and was kept. Test counts before → after: `actions-scripts` 20 → 19, `actions-discovery` 24 → 23, `projections` 3 → 3.

### `test/otel/tabShell.test.ts` (task 5.2)

6 → 3 tests.

| Removed | Rationale | Surviving detector |
| --- | --- | --- |
| "TraceStore backward-compatible with existing API" | four `typeof x === "function"` existence checks | `tsc --noEmit` plus every suite that calls `loadFile`/`getTraceSummaries`/`applyFilter`/`setSort` |
| "MetricStore starts empty" | duplicate fresh-constructor case | `test/otel/metricStore.test.ts` "handles empty store" (`metricCount_` 0, `getStreams()` `[]`) |
| "LogStore starts empty" | duplicate fresh-constructor case | `test/otel/logStore.test.ts` "handles empty store" (`logCount_` 0, `getLogs()` `[]`) |

Kept as unique: fresh `TraceStore` counts (no owning suite asserts an unloaded trace store), fresh `TopologyStore` (`getServices()` `[]`), and "stores are independent". A file header now states what this suite owns and where the rest lives.

### Source/asset/prose assertions (task 5.3)

| Removed | Rationale | Surviving detector |
| --- | --- | --- |
| `test/go-retirement.test.ts`: `shell not.toContain("startOwnedBackend")` | duplicate of the source-wide retirement walk's `/startOwnedBackend/` pattern, which scans all of `src/` (including `tui/index.tsx`) | "no source reaches a retired backend artifact or bridge" |
| `test/go-retirement.test.ts`: reading `src/cli.ts` and asserting `not.toContain("__grpc-sidecar")` | duplicate of the same walk's `/__grpc-sidecar/` pattern (walk covers `src/cli.ts`) | same test |

Probe: injecting `startOwnedBackend` into `src/tui/index.tsx` and `__grpc-sidecar` into `src/cli.ts` made the walk fail; after restoring, `go-retirement` passes 5/5 and `git diff src/` is empty.

Kept deliberately: `test/workflow-assets.test.ts` (embedded asset packaging, extension/bridge content contracts, and the `instructions/verification.md` policy text — unique instruction-policy coverage with no other detector), `test/workflow-module-exports.test.ts` (captured export baseline), `test/workflow-wiki-scope.test.ts` (embedded wiki/archive instruction equality), and the cosmetic/rendering suites.

### Positive controls (task 5.4)

| Probe | Mutation | Baseline | Result |
| --- | --- | --- | --- |
| live trace refresh rejects empty summaries | `TraceStore.getTraceSummaries()` returns `[]` | `traceLiveRefresh.test.tsx` 1 pass | `(fail) traces tab reflects store loads and live pushes after mount` — 0 pass / 1 fail |
| server authorization rejects forged tokens | `constantTimeEqual` check dropped in `src/server/auth.ts` (forged bearer accepted) | `server-api.test.ts` 36 pass | `(fail) instance authorization > rejects a missing or forged capability` — 35 pass / 1 fail |

Both source files were restored (`git diff --stat src/` empty); the two suites then pass **37 pass / 0 fail**.

## 6. Runtime smoke truthfulness (tasks 6.1–6.4, rows L15–L17)

`test/runtime-smoke.test.ts` rewritten:

- **Prerequisites before registration.** `containerPrerequisites()` /
  `clusterPrerequisites()` run once at module load (top-level `await`) and return
  a reason string when unsatisfied: no opt-in, no reachable container runtime,
  missing local image, missing `kind`/`kubectl`, no reachable managed cluster. All
  four cases are declared with `test.skipIf(!prerequisites.ok)`, and Bun reports
  them as skipped — the previous `console.log("skip: …")` + `return` paths that
  counted as passes are gone.
- **Attempted operations fail.** `createContainer()` and the label read now throw
  instead of logging a skip, and the Kubernetes fixture's `kubectl` helper throws
  on a command error, so nothing converts a real failure into a passing skip.
- **Preservation sentinels (task 6.2).** The container fixture creates a
  second container under a *different* owner label (`sentinel-<runId>`), reads its
  `ContainerID`, `Status` and labels, exercises this run's own create/start/remove
  path on a container it owns, then asserts the sentinel is byte-identical and
  that the run's name matcher never selects it. Teardown removes only the two
  containers this run created. The Kubernetes fixture does the same with a
  sentinel namespace (uid + owner label + phase read before/after) and deletes
  only its own namespaces. The previous near-vacuous checks (`Names.length === 0`
  must be empty, `Id !== ""`, release-namespace inequality) are gone.
- **Aggregate reporting (task 6.3).** `scripts/test.ts` now parses Bun's skip
  count (`reportedSkips`) and prints
  `<executed> executed tests (<n> skipped) in <s>s`, where executed = reported
  total − skips. Process isolation, per-file watchdogs, the 15 s test timeout,
  unparsed-count detection, and non-zero failure exits are unchanged. Focused
  argument runs still exec Bun directly.

### Skip-path evidence (task 6.4)

Commands run from `agentic-coding/` (Bun 1.4.2):

| Invocation | Observed |
| --- | --- |
| `bun test test/runtime-smoke.test.ts` | `skip: set DEVENV_SMOKE_RUNTIME=docker …` + `skip: set DEVENV_SMOKE_RUNTIME=kubernetes …`, `0 pass / 4 skip / 0 fail` |
| `DEVENV_SMOKE_RUNTIME=docker bun test test/runtime-smoke.test.ts` | `skip: no container runtime is reachable`, `0 pass / 4 skip / 0 fail` |
| `DEVENV_SMOKE_RUNTIME=kubernetes bun test test/runtime-smoke.test.ts` | `skip: no reachable managed cluster (state missing); the fixture never creates one`, `0 pass / 4 skip / 0 fail` |

Failure-path probe (attempted operation must fail, not skip): prerequisites forced
satisfied against a non-existent runtime command. Result: `0 pass / 2 skip /
**2 fail**` — `could not create disposable container …`, with the Kubernetes cases
still skipping for their own unmet prerequisite. Probe file restored
byte-identical.

**Unverified:** no live smoke run was executed. This machine has no reachable
Docker/Podman daemon and no managed kind cluster, so the create/lifecycle/logs/
namespace paths are recorded as **skipped/unverified — not passed**. Running them
requires an explicitly opted-in machine
(`DEVENV_SMOKE_RUNTIME=docker|kubernetes …`).

## 7. Deletion / repair ledger (task 1.3)

No candidate is removed on filename or size grounds. Rows marked **retained**
are recorded here because the audit flagged them.

| # | Candidate | Protected guarantee | Decision | Surviving detector / rationale |
| --- | --- | --- | --- | --- |
| L1 | `test/workflow-steps.test.ts` repeated digest block (≈10.5k lines) | 489 historical definitions keep independent expected identity/version/definition-digest/step-association/step-digest/order | compact (task 2.1–2.3) | Compact literal fixture + one runtime comparison over the whole guarded set; values stay pre-captured literals, never registry output |
| L2 | `test/app/pagesRender.test.tsx`: `opened.push(entries[selected()].route)` | Enter on a home/category destination dispatches that route | remove | `appShellMount.test.tsx` (Ctrl+P → type → Enter → `Home › Environments › Libraries`), `pageNavigation.test.tsx` "Ctrl+P jumps straight to a destination" |
| L3 | `test/app/pagesRender.test.tsx`: `opened.push(observabilityDestinations(SURFACE)[1].route)` | Category page opens the selected child route | remove | same as L2 during the real picker jump |
| L4 | `test/app/pagesRender.test.tsx`: `accepted.push(matches[0].route)` | Location-picker acceptance emits the filtered route | remove (check retained) | `appShellMount.test.tsx` + `pageNavigation.test.tsx` drive the real picker keymap; `pickerSelection`/`filterPickerEntries` still asserted as production pure functions |
| L5 | `test/app/pagesRender.test.tsx` breadcrumb render assertions | Breadcrumbs render ancestors, collapse one row, never overflow | retain | Unique rendering coverage; no other suite asserts the narrow-terminal collapse |
| L6 | `test/dash/modalCentering.test.ts` synthetic `createTestRenderer` overlay | Modal centers relative to the **terminal root**, not offset shell content | replace then delete (task 3.2) | New production-modal-under-offset-shell assertion in `sharedPrimitives.test.tsx`; that suite keeps stacking/lifecycle and its own centering click probe |
| L7 | `test/otel/topologyStore.test.ts` "detects cycles gracefully" | Cycle handling in the topology layout | repair (task 3.3) | Case currently loads a single span with no cross-service edge; must exercise a genuine service cycle or drop the cycle claim |
| L8 | `test/otel/otlp-grpc.test.ts` "handles oversized payload gracefully" | Payload-size protection | rename + keep as nullish coverage (task 3.3) | Fixture passes `null`/`undefined`, not an oversized payload; byte limits live at the receiver boundary |
| L9 | `test/environment-ownership.test.ts` `content from "…"` regex | Workflow/telemetry must not depend on environment state/manager/private-api | repair (task 4.1–4.2) | Resolved dependency edges from `scripts/workflow-module-graph.ts`; composition-root access stays allowed |
| L10 | `test/environment-ownership.test.ts` cross-database isolation case | Creating environment authority touches only `state.db` | retain | Real temp-dir run; the spec's "real cross-database isolation test" |
| L11 | `test/otel/tabShell.test.ts` empty-state + independence cases | Each store starts empty; no cross-contamination | retain | Unique empty-state guarantee (spec: "unique empty-state guarantee in its owning suite") |
| L12 | `test/otel/tabShell.test.ts` "backward-compatible with existing API" | `TraceStore` still exposes `loadFile`/`getTraceSummaries`/`applyFilter`/`setSort` | remove (task 5.2) | `typeof x === "function"` constructor/method-existence check only; `tsc --noEmit` plus `traceStore`/`traceLiveRefresh` suites fail on a real signature break |
| L13 | `test/actions-scripts.test.ts` local `shape` helper test | Test-local fixture normalizer | remove (task 5.1) | No product guarantee; helper only feeds the production assertions in the same file |
| L14 | `test/actions-discovery.test.ts` `caseNamed("nope")` throw case | Test-local fixture-case lookup | remove (task 5.1) | No product guarantee; `shape`/`caseNamed` remain as fixture plumbing |
| L15 | `test/runtime-smoke.test.ts` 4 early `console.log("skip")` + `return` cases | Opt-in docker/kubernetes smoke | repair (task 6.1) | Must report as **skipped**, never pass; failures after satisfied prerequisites must fail |
| L16 | `test/runtime-smoke.test.ts` docker "foreign container is never selected or removed" | Foreign containers survive the fixture | repair (task 6.2) | Current assertions are near-vacuous (`Names.length === 0` must be empty, `Id !== ""`); needs before/after sentinel identity+state |
| L17 | `test/runtime-smoke.test.ts` kubernetes "no user release is touched" | Foreign releases survive the fixture | repair (task 6.2) | Only asserts namespace name inequality against this run's id; needs a test-owned separate-owner sentinel compared before/after |
| L18 | `test/dash/sharedPrimitives.test.tsx` stacking/lifecycle/copy cases | Modal z-order, independence, selection-copy routing | retain | Spec requires preserving these; independent of centering |
| L19 | `test/otel/traceLiveRefresh.test.tsx` empty-summary rejection | Live refresh rejects empty summaries | retain | Positive control for task 5.4 |
| L20 | `test/server-api.test.ts` forged-token rejection | Server authorization rejects forged bearer tokens | retain | Positive control for task 5.4 |
| L21 | `test/dash/phaseStatus.test.tsx` blocked-phase case | Blocked current phase renders its label plus a separate `BLOCKED` indicator | repair (flake) | Same assertions, now awaited via `waitForFrame` instead of one `renderOnce()`; probe removing the production indicator fails the case (§8.1). Pre-existing flake, file otherwise untouched by this change |

Still-classified items from that list: repeated deterministic calls in
`test/dash/projections.test.ts` (removed, §6), and source/asset/prose assertions
(two mapped removals in `test/go-retirement.test.ts`; asset/instruction-policy
suites deliberately kept, §6).

## 8. Final verification

Bun 1.4.2, commands run from `agentic-coding/`.

| Command | Result |
| --- | --- |
| `bun run test` | **PASS** — 179/179 test files, **1706 executed tests (4 skipped)** in ~61–63 s, across seven complete runs (six idle, one loaded) after the identifier-compaction work; the only failure seen was the intermittent `phaseStatus` case now repaired (§8.1) |
| `bun run test:devenv` | **PASS** — 41 files, **171** tests, 418 `expect()` calls, 0.96 s (identical to baseline) |
| `bun run lint` | **0 diagnostics** — `Checked 870 files` |
| `bun run type-check` | **clean** (`tsc --noEmit`) |
| `bun run build` | succeeded; `embedded 25 files (sha1-7ebfcba61e33)` → `src/workflow/embedded.generated.ts` unchanged in git status (generated output reviewed, never hand-edited) |
| `openspec validate cleanup-tests-without-coverage-loss --strict` | **valid** |

### Count and size reconciliation

| Measure | Before | After | Δ |
| --- | --- | --- | --- |
| `test/` files | 180 | 179 | −1 (`dash/modalCentering.test.ts`) |
| `test/` lines | 63,757 | 56,569 | −7,188 (−11.3 %) |
| `packages/devenv` | 41 files / 4,811 lines | unchanged | 0 |
| Reported tests | 1714 | 1710 (1706 executed + 4 skipped) | −4 |
| Executed passes | 1714 | 1706 | −8 |

The −4 net test cases are: `actions-scripts` self-test, `actions-discovery`
self-test, `tabShell` method-existence check, `tabShell` MetricStore/LogStore
fresh-empty duplicates, `workflow-module-import-cycles` subset cycle scan and
`modalCentering` (−7), offset by new production-backed checks in
`sharedPrimitives` (modal centering), `environment-ownership` (import-form guard
fixtures) and `topologyStore` (genuine cycle + same-service non-edge) (+3). The
remaining −4 executed passes are the four runtime-smoke cases that used to return
early and count as passes; they now report as skipped.

### Working tree

At baseline the tree was clean (HEAD `ff40d91`); no concurrent work was present,
so nothing unrelated was touched. The only modifications are the test files
listed above, `test/dash/phaseStatus.test.tsx` (intermittent-failure repair,
below), `scripts/test.ts`, and this change's artifacts.

### Remaining uncertainty

1. **The one intermittent full-suite failure was identified and repaired.** The
   first post-change `bun run test` reported one failure from a 4-test file with
   exactly 7 `expect()` calls and a ~1026 ms runtime. Matching all three signals
   against every 4-test file pointed at `test/dash/phaseStatus.test.tsx` (7
   expects; 893/939/893/1377 ms across runs) and ruled out the only other 7-expect
   candidate, `test/herdr-client.test.ts` (216–284 ms). Its first case asserted a
   `BLOCKED` frame from a **single** `await t.renderOnce()`, which can capture a
   pre-composite frame under the pool — the timing risk the design lists
   ("renderer tests depend on timing … use existing renderer flush/wait helpers").
   The repair waits for the frame the assertions need instead
   (`waitForFrame((value) => value.includes("BLOCKED"))`); the assertions
   themselves are unchanged. Evidence: mutation probe removing the production
   `BLOCKED` indicator now fails that case (`1 fail`), restored it passes
   (`4 pass`, 7 expects); 30 loaded runs of the file pass; seven subsequent
   complete suite runs pass, including one under four spinning CPU hogs
   (87.47 s). No contract test was deleted or relaxed to obtain the green runs.
2. **Live runtime smoke is unverified.** No reachable container runtime and no
   managed cluster on this machine, so the docker/kubernetes create → lifecycle →
   observation → cleanup paths are recorded as skipped, not passed. Only the
   skip paths, the sentinel-preservation code, and the "attempted operation
   fails" path were exercised (forced prerequisites → 2 fail).
3. **No claim of exhaustive equivalence.** Removal rows name a surviving detector
   for the relevant inputs; this is not mutation-complete evidence.
4. Deferred by design: broad cosmetic pruning and the repository-wide `AGENTS.md`
   testing policy (task 7.4).
