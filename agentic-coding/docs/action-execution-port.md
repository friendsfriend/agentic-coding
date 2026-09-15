# Environment action execution port

`port-action-execution-to-bun` moves environment action execution — the action
registry, the run/step/command tree, the executor, and the script/shell action
lifecycle — from the Go child into the Bun server, keeping the legacy `/api/*`
contract. It is deliberately separate from the workflow state machine and its
durable outbox: environment actions have immutable versioned definitions,
semantic step trees, deduplicated execution keys, typed scoped values,
readiness gates and dependency leases, and environment retry semantics are
ported on their own terms.

Route ownership is a per-family entry in `LEGACY_ROUTE_OWNERSHIP`
(`src/server/integrations/routes.ts`); this change moved the `actions` and
`scripts` families in-process. Every family is served in this process since the
Go backend was retired ([`go-retirement.md`](go-retirement.md)).

## Prerequisite (task 1.1)

`port-git-providers-and-ai-to-bun` is implemented and archived (24/24 tasks
checked, `openspec/changes/archive/2026-09-14-port-git-providers-and-ai-to-bun`).
Its result is what this change depends on:

- Bun owns the Git/provider/GitHub/GitLab/CI/AI surface and the environment
  authority (the Go-side adapters that reached them are deleted).
- `src/server/integrations/routes.ts` owns the static route manifest, and this
  port moved two more families into it.
- The Bun-owned `action_events`, `action_log_events`, `script_args_history` and
  `dependency_leases` tables already live in
  `src/server/environment/state-store.ts` (ported by
  `port-project-catalog-and-state-to-bun`), so this change adds behavior, not
  schema.

## Owner inventory (task 1.1)

### Go owners this change replaces

| Owner | Location | Owns |
| --- | --- | --- |
| Definition model | `pkg/actiondef/{types,descriptor,validate}.go` | Stable IDs (`ActionID`, `StepDefinitionID`, `ExecutionKey`, `ValueKey`), typed inputs/ports, tree validation, `StableID` |
| Run tree | `pkg/actionrun/{types,registry,labels,snapshot}.go` | Run/step/command records, active-run reservation, 24-hour history retention, canonical step-label registry, secret/ephemeral-stripped definition snapshots |
| Definition registry | `pkg/actionregistry/{registry,targets,infrastructure,git,docker_lifecycle,kubernetes,kubernetes_lifecycle,kubernetes_validation,toolcheck}.go` | Provider compilation, atomic versioned snapshot publication, tool availability, target→action compilation |
| Executor | `pkg/actionexec/{engine,coordinator,command,process,readiness,projection,operation,container_readiness,compose_readiness,kubernetes_readiness}.go` | Step execution, composite conditions/failure policy, execution-key leases, typed value store, command/process handlers, readiness probes, event→run projection |
| Target discovery | `pkg/resources/{action_targets,manager,scripts,shell_actions,dependency_graph,kubernetes_*,envfile,endpoints}.go` | Build/test/run target discovery, endpoint contracts, dependency graph, script definitions |
| Handlers | `pkg/server/{action_registry,handlers_action_definitions,handlers_action_history,handlers_action_events,action_events,action_dependency_validation,script_actions,handlers_scripts,script_metadata_process_unix}.go` | The `actions` and `scripts` route families, history/log reads, event reporting, script CRUD/link/delete, metadata discovery |
| Runtime actions (not this change) | `pkg/server/{docker_actions,kubernetes_actions}.go`, `pkg/actionregistry/{docker_lifecycle,kubernetes_lifecycle}.go` | Container/Kubernetes capability execution — owned by `port-environment-runtimes-to-bun` |

`pkg/server/server.go` (`AddActionEvent`, `AddActionLogEvent`) and
`pkg/server/handlers_scripts.go` (`AddScriptArgsHistory`) are the persistence
writers; they already write through the Bun-owned state store
(`docs/environment-state-port.md`).

### Bun owners

| Module | Owns |
| --- | --- |
| `src/server/actions/definition.ts` | Immutable action/step model, typed ports, tree validation |
| `src/server/actions/identity.ts` | `stableId`, the one composition per compiled action family, `actionTargetId` |
| `src/server/actions/labels.ts` | Canonical step-kind label registry, command classification, action-kind bucketing |
| `src/server/actions/targets.ts` | Runtime resource model (`ActionTarget`, `InfraService`, kubernetes identity and tool set) |
| `src/server/actions/compile.ts` | Resource definition compilers (git, compose lifecycle, kubernetes lifecycle and cluster, infrastructure, generic operation) and kubernetes identity validation |
| `src/server/actions/target-compile.ts` | Target-driven compilers (`CompileTargetGraph`, `CompileContainerTargetsWithTools`, tmux variants, dependency steps, readiness gates, port forwards, Docker build/artifact pipeline) |
| `src/server/actions/registry.ts` | Provider compilation, duplicate/validation rejection, atomic versioned snapshot publication |
| `src/server/actions/run-registry.ts` | Run/step/command records, reservation, 24-hour retention, definition snapshots |
| `src/server/actions/step-result.ts` | Step kind/condition/failure-policy contract and the handler boundary |
| `src/server/actions/values.ts` | Typed named values, `fmt.Sprint`-compatible rendering, `${key}` template resolution |
| `src/server/actions/coordinator.ts` | Execution-key leases, resource claims, cancellation and late-result rejection |
| `src/server/actions/engine.ts` | Step executor: execution-key deduplication, composite conditions and failure policy, events |
| `src/server/actions/command.ts` | Command steps: one process per executed command, capture and redaction |
| `src/server/actions/process.ts` | Managed long-lived processes and the process store |
| `src/server/actions/readiness.ts` | Readiness gates and the tcp/http/container/compose/kubernetes/process probes |
| `src/server/actions/projection.ts` | Engine events → the run tree history serves |
| `src/server/actions/scripts.ts` | Script discovery, target paths, create/link/delete, interpreter selection, metadata parsing/cache/bounded probing, script tree, shell-action scripts and their tmux metadata |
| `src/server/actions/process-group.ts` | Process-tree cancellation for command, metadata and managed-process cancellation |
| `src/server/environment/state-store.ts` | `action_events`, `action_log_events`, `script_args_history`, `dependency_leases` persistence (existing) |

### Not yet ported (elsewhere in this change)

The compilers take a discovered target as input; producing it is an I/O
boundary, not compilation, and lands with the providers that call it:

- `resources.DiscoverActionTargets` and the per-runtime probes in
  `pkg/resources/{action_targets,manager}.go` (build tools, compose files, shell
  script metadata) plus `toolcheck.CheckToolAvailability` — task 4.2, next to the
  registry providers. They need the Bun equivalents of `ResolveConfigDir`,
  `ResolveHomeDir` and env-file loading, which `src/server/environment/config.ts`
  already owns.
- Request-boundary validation: `resources.ValidateEndpointContracts`
  (`pkg/resources/endpoints.go`), the target registry and start plan
  (`pkg/resources/dependency_graph.go`) and `validateActionDependencies`
  (`pkg/server/action_dependency_validation.go`) — task 4.x, consumed when
  `POST /api/action-runs` switches owner.
- Script definitions and handlers (`pkg/resources/scripts.go`,
  `pkg/server/handlers_scripts.go`) — section 3.

### Execution semantics (ported)

`src/server/actions/{step-result,values,coordinator,engine,command,process,readiness,projection}.ts`
port `pkg/actionexec` and `pkg/actiondef`'s step contract. Deliberate differences
from the Go implementation, all asserted by a test:

- **The executor is asynchronous.** Go executes a step synchronously; spawning a
  process is not. The engine therefore awaits handlers, and `RunRegistry` is the
  only mutable state — one synchronous method per mutation, never across an
  `await`.
- **An already-running step completes explicitly.** Go's coordinator returns a
  non-owner lease for a resource its ready probe found running, so the engine
  treats it as a *shared reference* and never emits `step.completed`: the run
  tree keeps that node `active` forever. Bun announces the step and completes it
  with the `already-running` outcome, which is what makes the outcome explicit
  without inventing a command.
- **A reference node keeps its label.** Go emits `step.reference` without a
  label, so history renders `↳  (shared)` with an empty name; Bun carries the
  semantic step's label.
- **`RunRegistry.active`/`activeForApp` return start order** where Go iterated a
  map (see task 1.4).
- **The source/process probes are injected** rather than read inside the
  compiler or the executor, so a fixture can pin them.

### Scripts and processes (ported)

`src/server/actions/scripts.ts` ports `pkg/resources/{scripts,shell_actions}.go`
and the pure parts of `pkg/server/{handlers_scripts,script_actions}.go`.

Fixture: `test/fixtures/actions/scripts.json` (`server/pkg/resources/scripts_fixtures_test.go`)
and `test/fixtures/actions/script-server.json`
(`server/pkg/server/scripts_fixtures_test.go`), asserted by
`test/actions-scripts.test.ts` and `test/actions-script-runtime.test.ts`.

Deliberate differences and boundaries:

- **Process-tree cancellation replaces process groups.** Go calls `Setpgid` and
  kills `-pid` on a metadata timeout. Bun's `spawn` has no `setpgid`/`detached`
  option, so the child stays in the server's group and signalling that group
  would kill the server. `process-group.ts` resolves the descendant set from the
  process table and signals it leaves-first; Windows uses `taskkill /T`. The
  observable requirement — cancelling a wrapper cancels what it started — is
  asserted with real processes.
- **The Windows plan path is asserted against a stubbed platform.** Both
  `resources.ResolveInterpreter` and `resolveScriptExecutionPlan` switch on the
  *runtime* platform in Go, so only the unix plan can be captured on this
  machine. The interpreter mapping underneath it is captured
  platform-independently (`interpreters` in `scripts.json`), including the Go
  quirk that `PWSh.EXE` is not recognized while `pwsh.exe` is.
- **Metadata parameters are normalized.** Go unmarshals into
  `resources.ScriptParameter`, which drops unknown fields and always emits
  `required`; the port does the same, so a script's extra key cannot reach a
  response.
- **tmux pane launching is out of scope here.** `pkg/operations` starts and
  polls tmux panes for *infrastructure* script services, which is the `app`
  route family and belongs to `port-environment-runtimes-to-bun`. This change
  owns the script contract that a launch consumes: the script path, the
  `# devenv:mode=tmux` header, the process handle and the pane-alive readiness
  probe.

## Route ownership (switched)

The manifest gained nine `actions` rows, seven `scripts` rows (the legacy mux
declares only GET for `/api/scripts` while the handler requires POST and the
devenv client posts there, so the manifest follows the real contract) and
`GET /api/events`. `GET /api/health` and the `app`, `docker` and `kubernetes`
families were ported by `port-environment-runtimes-to-bun`; every row is served
in this process.

`src/server/actions/routes.ts` is the handler for all seventeen rows:

| Route group | Behaviour |
| --- | --- |
| `GET /api/apps/{ident}/actions`, `GET /api/action-definition`, `GET /api/action-registry/status` | Serve the versioned snapshot; a failed rebuild keeps the previous version current and reports the error |
| `POST /api/action-runs` | Input validation (required, unknown), availability and blocked-stop conflicts, reservation, then an asynchronous run; `202` with the run id |
| `POST /api/actions/cancel` | Aborts the app's active runs through their own controller and records `canceled` |
| `GET /api/actions/history`, `GET /api/actions/logs` | Read the Bun-owned stores and compact consecutive output chunks into one frame |
| `POST /api/actions/events` | Accepted only for `action.*` types other than `action.history` |
| `GET /api/actions/shell-script` | Writes the shell or PowerShell action script with its `# devenv:mode` header |
| `GET/POST /api/scripts`, `POST /api/scripts/{create,link}`, `DELETE /api/scripts/delete`, `GET/POST /api/scripts/history`, `GET /api/scripts/metadata` | Discovery with bounded metadata probing, mutations, argument history and the parameter schema |
| `GET /api/events` | The one subscriber-facing legacy stream: greeting, a snapshot of active runs, then live events |

### Execution bridges

- **SDK-only container and Kubernetes operations** go through
  `src/server/actions/runtime-adapter.ts`: a closed operation set
  (`docker.container.{start,stop,restart}`, `kubernetes.cluster.refresh`), the
  run/step/command identity, cancellation propagation and a bounded response. The
  Go side executes one operation and allocates no run tree, so Bun stays the sole
  run/history owner and an SDK-only step stays commandless. With no adapter
  attached the step fails loudly rather than reporting success for work that did
  not happen.
- **Git steps run in-process.** A compiled `git` command step is argv executed by
  the same Bun boundary the Git capability uses. The Go forwarding bridge and its
  `server/pkg/integrations/runner.go` are deleted.
- **The legacy event stream is Bun's**, with no relay: the only producer is this
  process, so `relayLegacyEvents` is deleted.

### Cutover

The switch is quiescent and requires no reparenting:

- Bun's run registry and process store start empty on every start; a live Go
  command run is never adopted. Its persisted history stays readable through the
  same routes, and a cancel issued to the new owner cannot reach an old in-memory
  run.
- A run keeps the registry version and definition snapshot it started under, so a
  configuration reload underneath an active run leaves it and its later
  historical view unchanged.
- Rollback is the manifest entry per family plus the client's base URL: restoring
  `owner: "go"` for `actions`, `scripts` and `system` returns the family to the
  unchanged Go implementation, with no state migration in either direction (both
  owners read and write the same `action_events`, `action_log_events` and
  `script_args_history` tables).

### Adapter removal inventory (for `retire-go-backend-and-migration-bridges`)

| Item | Owner |
| --- | --- |
| `server/pkg/integrations/` (client and `ForwardingRunner`) and the `DEVENV_INTEGRATIONS_URL` selection in `handlers_action_definitions.go` | `port-environment-runtimes-to-bun`, when the `app` family stops owning runs |
| `src/server/actions/runtime-adapter.ts` and its Go endpoint | the same change, when Docker/Kubernetes capabilities are Bun-owned |
| `src/server/actions/event-stream.ts` relay | when the Go child stops producing events |
| Go's `pkg/actionexec`, `pkg/actionrun`, `pkg/actionregistry`, `pkg/actiondef` and the `actions`/`scripts` handlers | `retire-go-backend-and-migration-bridges` |

### Private adapters at cutover

| Adapter | Direction | Removed by |
| --- | --- | --- |
| `POST /api/v1/integrations/private/git-command` (`src/server/app.ts` `gitCommandOperation`, Go caller `pkg/integrations/runner.go` `ForwardingRunner`) | Go action owner → Bun Git | task 4.3 |
| Container/Kubernetes operation adapter (new, task 4.1) | Bun action owner → Go runtime | `retire-go-backend-and-migration-bridges` |

### Route rows this change owns

| Family | Routes |
| --- | --- |
| actions | `GET /api/apps/{ident}/actions`, `GET /api/action-definition`, `GET /api/action-registry/status`, `POST /api/action-runs`, `POST /api/actions/cancel`, `GET /api/actions/history`, `GET /api/actions/logs`, `POST /api/actions/events`, `GET /api/actions/shell-script` |
| scripts | `GET /api/scripts`, `POST /api/scripts/create`, `POST /api/scripts/link`, `DELETE /api/scripts/delete`, `GET /api/scripts/history`, `GET /api/scripts/metadata` |

## Fixtures

Go-created fixtures are the parity evidence; the Bun side replays them instead
of running both runtimes against one live mutation.

| Fixture | Generator | Asserted by |
| --- | --- | --- |
| `test/fixtures/actions/labels.json` | `server/pkg/actionrun/fixtures_test.go` | `test/actions-labels.test.ts` |
| `test/fixtures/actions/definitions.json` | `server/pkg/actionregistry/fixtures_test.go` | `test/actions-identity.test.ts` (stable ids), `test/actions-definitions.test.ts` (compiled definitions, validation, registry) |
| `test/fixtures/actions/target-ids.json` | `server/pkg/resources/fixtures_test.go` | `test/actions-identity.test.ts` |
| `test/fixtures/actions/targets.json` | `server/pkg/actionregistry/target_fixtures_test.go` | `test/actions-targets.test.ts` |

`definitions.json` records the raw Go definition JSON — id, owner, type,
runtime, label, inputs, availability, the whole step tree with each step's
kind, condition, failure policy, ports, handler and executable configuration —
so `test/actions-definitions.test.ts` asserts every compiled definition field by
field, plus the accept/reject decision and diagnostic for each hand-built
validation case.

Two normalizations are needed to compare it to the port, and both are wire
questions rather than behavior questions:

- The kubernetes cluster actions embed the user's kubeconfig path, which Go bakes
  into its cluster specifications at package init. The fixture keeps it as a
  `{{HOME}}` recipe key; the test substitutes its own home.
- Go emits `"inputs": null` for an action with no inputs (its slice is nil) where
  the port carries an empty array. `GET /api/action-definition` serves the
  definition verbatim, so the route payload must reproduce Go's `null`; that is
  asserted by a captured payload fixture when the `actions` family switches
  owner (section 4).

The labels fixture carries one deliberate divergence: a templated kind reached
without its args renders fmt's `%!s(MISSING)` in Go and substitutes nothing in
Bun. That case is unreachable through a compiled definition, and the Go value
stays recorded so the difference cannot drift unnoticed.

`targets.json` records target-driven compilation (compose leaf, tmux variant,
dependency recursion, readiness, port forwards, secrets, Docker build/artifact
pipeline). It materializes a real directory tree, so every path in the fixture is
a `{{ROOT}}` recipe key and the test rebuilds the same tree in its own temp root;
the resolver table is derived from the resolver the definitions were compiled
with, so a reference Go could not resolve resolves to nothing in Bun too.

Regenerate with:

```bash
DEVENV_ACTION_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/actions \
  go test ./pkg/actionrun ./pkg/actionregistry ./pkg/resources -run 'TestWrite(Action|Target)Fixtures'
```

Without the env var every generator skips, so a normal `go test ./...` never
writes into the repository.
