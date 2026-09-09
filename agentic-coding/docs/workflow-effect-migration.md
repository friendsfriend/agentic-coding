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
| Store/kernel/reducers/security | `runtime/store.ts`, `runtime/engine.ts`, `runtime/view.ts`, `runtime/reducers/*`, `runtime/capability.ts`, `runtime/dialogue.ts` | 2 | CLI, dashboard | SQLite via `secure-fs.ts`/store adapter |
| Startup/config/profiles | `startup.ts`, `profiles.ts`, `paths.ts` | 2 | CLI, engine | `Bun.file`/env via `effects.ts` seam |
| Runner/adapters/credentials/wiki/assets | `effect-runner.ts`, `adapters.ts`, `credentials.ts`, `wiki.ts`, `assets.ts`, `secure-fs.ts`, `process.ts`, `failures.ts`, `herdr-schema.ts` | 3 | engine | git/subprocess/fs/network are native boundary adapters |
| Telemetry | `observability.ts`, `effects.ts` (TraceExporter) | 4 | engine, CLI | OTLP HTTP exporter is a native boundary adapter |
| CLI | `cli/*`, `cli.ts` | 4 | bin | process/env |
| Workflow-facing TUI/shared clients | `tui/dash/*` consumers | 4 | dashboard | n/a |

## Migration-only bridges (phase 4 removal owners)

`Contract<T>` facades in `contracts.ts` / `definitions/contracts.ts` are the
phase-1 compatibility bridges between the unmigrated engine callers and the
single Schema implementation:

| Exact symbol | Caller | Removal phase | Removal check |
| --- | --- | --- | --- |
| `Contract.parse` on `commandContract` | `runtime/engine.ts:dispatch` | 4 | engine consumes the Schema-decoded command type directly |
| `parseSnapshot` | `runtime/engine.ts`, `runtime/store.ts`, `runtime/view.ts` | 4 | store/view decode through the Schema snapshot contract |
| `parseDeveloperQuestionAnswer` | `runtime/dialogue.ts`, `commandContract` | 4 | dialogue decodes through Schema |
| `Contract.parse` on `researchHandoffContract` | `runtime/reducers/research-handoff.ts` | 4 | reducer decodes through Schema |
| `Contract.parse` on `planResult`/`planDraft`/`triage`/`findings` | `runtime/engine.ts`, `steps/planning.ts` | 4 | steps/engine decode through Schema |
| `EffectRunner.drain` Promise facade | `operations.ts` (`drainEffects`), CLI `drain` command | 4 | CLI/TUI drain through the Effect boundary directly |
| `agentEffectHandlers` / `AdapterEffectOptions` | `operations.ts`, `cli/pane.ts` | 4 | CLI consumes registered handler coverage through the Effect boundary |

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

- Store/clock/config services in `runtime/services.ts`; scoped SQLite
  acquisition/close and the non-suspending synchronous transaction primitive
  (`WorkflowStore.transaction`); one live/test clock for lease decisions.
- Engine dispatch/start/renew/claim as Effect programs behind the
  `WorkflowEngine` facade (`run` + `engineLayer`); capability/evidence
  operations; startup reads through `WorkflowConfig`.
- No nested runtime execution inside engine services or SQL callbacks.

## Phase-3 done (migrate-workflow-execution-to-effect)

- **Scoped runner** (`effect-runner.ts`): `EffectRunner.drain` runs one Effect
  program per claim inside an execution scope with a supervised renewal fiber
  (engine-clock cadence, `engine.renewEffect`, rejection/exception marks the
  lease lost and aborts external work, never an unhandled timer error). Serial
  just-in-time claims and final lease validation are retained.
- **Typed failure policy**: `TransientFailure`/`PermanentFailure` in
  `failures.ts` + `classifyFailure` (`effect-runner.ts`); `WorkflowFailure`
  tags still classify through `isRetryableFailure`. Known permanent
  configuration/validation failures and defects enter attention immediately
  instead of consuming the transient retry budget; ownership loss never
  publishes under an old lease; interruption stops work without claiming
  completion; observation failure is never treated as confirmed absence.
  Persisted attempt accounting/backoff stays entirely in the outbox — the
  runner never silently re-executes a mutating handler.
- **Async process service** (`process.ts`): bounded output (overflow kills the
  child), hard timeout, real child cancellation with bounded termination/reader
  cleanup, and typed `exit|timeout|canceled|overflow` failures. Termination
  signals the direct child only; descendants observe pipe EOF (deliberate —
  detached managed agents are never group-killed).
- **Herdr envelope Schema boundary**: one parser in `herdr-client.ts`
  (`parseHerdrResult`) + `decodeHerdrResult`; envelope schemas in
  `herdr-schema.ts`; `HerdrLifecycle`/`AgentAdapter` in `adapters.ts` are
  Effect-native with stable agent identity recovery unchanged.
- **Credentials** (`credentials.ts`): `runGitWithCredentialsEffect` over the
  askpass/FIFO relay — shim lifecycle scoped to the operation (0700/0600,
  cleanup guaranteed, no retained secrets); missing interactive prompt is
  permanent, everything else infrastructure.
- **Wiki pinned roots**: `wiki.ts` read/write/verify operations take an
  explicit optional root; `withWikiRoot` process-wide environment mutation is
  deleted from `effect-runner.ts` and `runtime/evidence.ts`; environment is
  only set in child launch options.
- **Handlers**: every registered `EffectKind` has an Effect-native
  `observe`/`execute`/`cancel` handler (coverage gate in
  `test/workflow-execution.test.ts`); durable resources (workspaces, adopted
  panes, launched agents) intentionally outlive a drain and are only torn down
  under exact identity/ownership checks.
- **Secure I/O**: descriptor-relative no-follow primitives (`secure-fs.ts`)
  remain the native boundary for artifacts, run environments, env pointers,
  and isolation checks; assignment rendering and asset path computation stay
  pure. Capability protections, size checks, and atomic publication verified by
  the focused and adversarial suites.
- **Tests**: `test/workflow-execution.test.ts` (policy, renewal rejection/
  exception, cancellation during observation, exact attempt counts, cleanup
  failure without false success, process service exit/timeout/cancel/overflow,
  Herdr schema drift, credential no-UI + no-retained-secrets, overlapping wiki
  roots). Real subprocess, SQLite takeover, and crash-after-success recovery
  cases retained.

## Remaining outer bridges (phase 4)

`operations.ts` `drainEffects` still awaits the Promise facade
(`EffectRunner.drain`), and `cli/pane.ts` still uses the sync
`isPaneLive`/`resolveLiveAgent` helpers; the CLI/TUI composition boundary and
`effects.ts` telemetry are phase-4 scope.

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