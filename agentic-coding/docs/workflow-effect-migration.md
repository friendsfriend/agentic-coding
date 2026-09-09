# Workflow Effect migration inventory

Module/caller inventory for the full workflow-layer Effect migration roadmap
([README](../../openspec/changes/adopt-workflow-effect-foundation/README.md)).
Each entry names its owning phase, callers, pure/native boundary exceptions,
and any migration-only bridge with its exact symbol and removal owner. This
inventory is what prevents a partial migration from silently becoming the end
state: **phase 4 removes every migration-only bridge.**

The four roadmap phases and their owners:

| Phase | Change | Owns |
| --- | --- | --- |
| 1 | `adopt-workflow-effect-foundation` | Effect version, Schema contracts, tagged failures, playbook + baseline |
| 2 | `migrate-workflow-runtime-to-effect` | Store/application services, engine API, evidence, startup/config |
| 3 | `migrate-workflow-execution-to-effect` | Runner, handlers, process/Herdr/filesystem/credential/wiki adapters |
| 4 | `complete-workflow-effect-cutover` | CLI/TUI ownership, telemetry, remaining callers, shim deletion |

## Module groups

| Group | Files | Owner phase | Callers | Pure/native boundary |
| --- | --- | --- | --- | --- |
| Contracts & definitions | `contracts.ts`, `schema.ts`, `definitions/contracts.ts`, `definitions/steps.ts`, `registry.ts` | 1 | engine, view, store, reducers, steps, CLI | Pure decoding; `path` normalization is a named pure step |
| Runtime services | `runtime/services.ts` | 2 | engine, startup | Store/clock/config services + scoped transaction primitive; SQLite is the native boundary |
| Store/kernel/reducers/security | `runtime/store.ts`, `runtime/engine.ts`, `runtime/view.ts`, `runtime/reducers/*`, `runtime/capability.ts`, `runtime/dialogue.ts` | 2 | CLI, dashboard | SQLite via `services.ts` store service; leaf helpers stay synchronous implementation details |
| Startup/config/profiles | `startup.ts`, `profiles.ts`, `paths.ts`, `effects.ts` (config I/O) | 2 | CLI, engine | `Bun.file`/env/git via `effects.ts` seam; config reads surface through `WorkflowConfig` |
| Runner/adapters/credentials/wiki/assets | `effect-runner.ts`, `adapters.ts`, `credentials.ts`, `wiki.ts`, `assets.ts`, `secure-fs.ts` | 3 | engine | git/subprocess/fs/network are native boundary adapters |
| Telemetry | `observability.ts`, `effects.ts` (TraceExporter) | 4 | engine, CLI | OTLP HTTP exporter is a native boundary adapter |
| CLI | `cli/*`, `cli.ts` | 4 | bin | process/env |
| Workflow-facing TUI/shared clients | `tui/dash/*` consumers | 4 | dashboard | n/a |

## Migration-only bridges (phase 4 removal owners)

`Contract<T>` facades in `contracts.ts` / `definitions/contracts.ts` are the
phase-1 compatibility bridges between the unmigrated engine callers and the
single Schema implementation. Phase 2 adds the synchronous `WorkflowEngine`
facade and startup bridge; every engine/startup operation behind them is an
Effect program with concrete service requirements.

| Exact symbol | Caller | Removal phase | Removal check |
| --- | --- | --- | --- |
| `Contract.parse` on `commandContract` | `runtime/engine.ts:dispatch` | 4 | engine consumes the Schema-decoded command type directly |
| `parseSnapshot` | `runtime/engine.ts`, `runtime/store.ts`, `runtime/view.ts` | 4 | store/view decode through the Schema snapshot contract |
| `parseDeveloperQuestionAnswer` | `runtime/dialogue.ts`, `commandContract` | 4 | dialogue decodes through Schema |
| `Contract.parse` on `researchHandoffContract` | `runtime/reducers/research-handoff.ts` | 4 | reducer decodes through Schema |
| `Contract.parse` on `planResult`/`planDraft`/`triage`/`findings` | `runtime/engine.ts`, `steps/planning.ts` | 4 | steps/engine decode through Schema |
| `WorkflowEngine` synchronous facade | CLI, dashboard, drain, `test/workflow-runtime.test.ts` | 4 | callers compose the Effect programs (engineLayer at the root; no `Effect.runSyncExit` in the class) |
| `engineLayer` merge | `runtime/engine.ts` | 4 | layers live at the true composition roots |
| `toRuntimeError` mapping | `runtime/services.ts` | 4 | programs fail with `WorkflowFailure` tagged union directly |
| `prepareWorkflowStart` sync bridge | CLI `commands/start.ts`, dash | 4 | entry points compose `prepareWorkflowStartEffect` with `WorkflowConfigLive` |
| Read-view `Effect.try` wrappers (`status`/`list`/`getSnapshot`/previews via `view.ts`) | `runtime/engine.ts` | 4 | view reads take handles from the store service |

Every retained facade **delegates to Schema** via `decodeContract`; none is an
independent validator. Pure contract identity descriptors (IDs/versions,
digests) are not migration shims and remain.

## Phase-1 done

- `effect@3.22.2` locked (task 1.1); Bun 1.4.0 / TypeScript 6.0.3 compatible.
- Command, developer-dialogue, snapshot/profile/settings, and built-in step
  contracts decode through Effect Schema (tasks 2.2–2.4).
- `WorkflowFailure` tagged union + `externalDiagnostic` mapping (task 2.1).
- Playbook: `docs/workflow-effect.md`.

## Phase-2 done

- Store service (`WorkflowStore` in `runtime/services.ts`) owns SQLite
  acquisition/close through a scope and the non-suspending synchronous
  transaction primitive (`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` all on the
  handle; no `yield*`/sleep/retry/nested runtime inside the callback).
  Legacy import runs through the autocommit `write` primitive outside the
  transaction primitive. Observed-store reads stay non-mutating.
- Clock service (`WorkflowClock`): single live/test clock; ownership
  timestamps are sampled after writer-lock acquisition (claim, renew, start,
  dispatch), never taken before an unbounded lock wait.
- Engine operations (initialize, start, dispatch, status, list, snapshot,
  repair/migration previews, capability issuance/authorization, claim,
  renew, liveness, run lookup) are Effect programs with typed
  `WorkflowRuntimeError` failures and concrete store/clock requirements,
  composed at the `WorkflowEngine` composition root via `engineLayer`.
- Committed command results are separated from post-commit
  scheduling/telemetry: interruption/notification failure after commit never
  replays the mutation or reports rollback.
- Config service (`WorkflowConfig`) + shared `prepareWorkflowStartEffect`
  startup preparation; pure routing/profile decisions remain deterministic.

## Phase-2 remaining

- `workflow-state-runtime` interruption/lock-contention regression checks and
  repo-wide verification fixtures belong to the verification step.
- `prepareStart/startRouting` remain synchronous helpers consumed by the
  dashboard coordinator today; they migrate to Effect when their callers do
  (phase 4), without RFCing service boundaries for pure routing.

## Contract characterization (task 1.3)

The Schema migration preserves the acceptance/rejection behavior, normalization,
serialized shapes, contract IDs/versions, and definition/step digests of the
previous hand-written parsers. Focused fixtures in
`test/workflow-effect-foundation.test.ts`, `test/workflow-question.test.ts`, and
`test/workflow-runtime.test.ts` pin the behavior:

- **Command** (`core.workflow-command@1`): discriminated on `type`; bounded
  text/integer/enum fields; optional `reason`/`artifact`/`message` default to
  their empty/absent forms; the "either description or questions" and
  "questionnaires use per-item context and options" cross-field invariants are
  enforced as pure validation after Schema decode; `answer-question` action
  input is routed through the developer-question answer schema.
- **Snapshot** (`core.workflow-snapshot`): `schemaVersion` is exactly `1`;
  repository-relative `metadata` paths are `path.resolve`-normalized, with the
  wiki/research empty-path exception preserved; legacy snapshots omit
  `developerDialogue` (defaults `[]`) and `changeId` (defaults `""`);
  per-record pending/resolved answer invariants, duplicate IDs, and byte
  bounds stay as pure validation.
- **Developer-question answer** (`core.developer-question`): single vs
  questionnaire (groupId) forms; option/custom require a value; cancel does
  not; responses are unique and bounded to 1–8.
- **Step contracts**: `core.json`, `core.empty`, `core.findings`,
  `core.research-handoff`, `core.triage-plan`, `core.plan-draft`,
  `core.plan-result` keep their IDs/versions and accepted shapes; path
  repository-relative checks, duplicate detection, and byte bounds remain pure
  validation in the facades.

Contract identities and historical definition/step digests are unchanged: they
depend on contract IDs/versions and explicit step/manifest fields, never on the
parser implementation. Schema metadata never enters durable pins or wire
values.
