# Design

## Context

See `proposal.md` - Why. Constraints that shape the approach:

- The workflow runner (`src/workflow/effect-runner.ts`), pane allocation (`src/workflow/cli/pane.ts`), tab/notification synchronization, the dashboard observation layer (`src/server/operations/observations.ts`), the dashboard event subscription (`src/server/herdr-events.ts`), and the detached drain boundary (`src/workflow/cli/drain.ts`) each construct Herdr CLI calls directly. `src/workflow/adapters.ts` holds `HerdrPort`, `HerdrLifecycle`, and the runtime adapters.
- `src/herdr-client.ts` is the single `.result` envelope parser and the single home of pane-geometry math; `src/workflow/herdr-schema.ts` holds the Effect Schemas for Herdr responses.
- Failure classification is message/type based (`classifyFailure`), and ownership loss is recognized by either an abort signal or an `Error` whose message matches the ownership phrases.
- The installed Luvus `0.14.2` exposes UHP methods over `LUVUS_SOCKET_PATH` (or `LUVUS_HOME`), selects a server session with `LUVUS_SESSION`/`--session`, returns `{id, result}` envelopes, and provides atomic `agent.start`/`agent.prompt`, `pane.processes`, `worktree.create`, `ui.notification.push`, and `events.subscribe`/`events.wait`.
- `docs/workflow-effect.md` requires one idiom per operation/error/schema/service/test boundary: Effect operations, typed errors, Effect Schema decoding at the foreign-API boundary.

## Goals / Non-Goals

**Goals:**

- One intent-level, Effect-native port that both runtimes implement, so callers name workflow concepts (workspace, tab, pane, agent, notification, event) instead of vendor commands.
- Byte-for-byte preservation of current Herdr behavior, including command arguments, retry timing, launch prompt confirmation, naming, and identity recovery.
- Selection and availability behavior that is loud, explicit, and never silently falls back.
- Focused, contract-first tests rather than a repository-wide suite.

**Non-Goals:**

- Sidebar publication and the Herdr custom Agents view. `src/workflow/sidebar-sync.ts` stays Herdr-specific and untouched.
- Renaming or generalizing the trusted `ui.herdr_notifications` preference key, which remains the opt-in switch for developer-action notifications.
- Switching an in-flight workflow between multiplexers, or migrating an existing workflow's workspace to another runtime.
- Adding any new runtime dependency for dispatch; the port is plain TypeScript plus the already-installed Effect `3.22.2`.

## Decisions

### Decision 1: Module layout and port surface

New modules, one responsibility each:

- `src/multiplexer/port.ts` - `MultiplexerPort`, normalized result types (`WorkspaceInfo`, `TabInfo`, `PaneInfo`, `AgentInfo`, `ProcessIdentity`, `MultiplexerEvent`, `NotificationOutcome`), and `MultiplexerError`.
- `src/multiplexer/herdr/cli.ts` - the moved Herdr subprocess boundary (`runHerdr`, `runHerdrAsync`, envelope parsing) plus pane-geometry helpers, so Herdr access still has exactly one module.
- `src/multiplexer/herdr/schema.ts` - the moved Herdr Effect Schemas.
- `src/multiplexer/herdr/index.ts` - `HerdrLifecycle` (moved) and the Herdr `MultiplexerPort` implementation.
- `src/multiplexer/luvus/{cli.ts,uhp.ts,schema.ts,index.ts}` - Luvus subprocess/socket transport, UHP request builders and event decoding, Luvus-specific schemas, and the adapter implementation.
- `src/multiplexer/factory.ts` - selector resolution and adapter construction.

The port exposes one required method per intent:

```
workspaceCreate | workspaceGet | workspaceList | workspaceFocus | workspaceClose | worktreeCreate
tabList | tabCreate | tabRename | tabFocus | tabClose
paneGet | paneList | paneSplit | paneRun | paneClose | paneLayout | paneFocus | paneForegroundProcesses
agentStart | agentGet | agentPrompt
notify | eventsSubscribe
```

Method semantics that carry current behavior:

- `workspaceGet`/`paneGet`/`agentGet` return `undefined` for confirmed absence and fail only on transport failure. `workspaceClose` observation keeps its current meaning: absence counts as already closed.
- `worktreeCreate` returns the worktree path and the workspace identity in one result, because Herdr's `worktree create` opens a workspace while Luvus needs `worktree.create` followed by `workspace.open`.
- `paneForegroundProcesses` normalizes Herdr `pane process-info` and Luvus `pane.processes` to `{ name, pid }` rows; the shell-readiness loop itself lives in the Herdr adapter, because Luvus `agent.start` already waits for readiness.
- `paneFocus` is required (not optional): Herdr keeps its layout-traversal loop behind this method, Luvus maps it to `pane.focus`.
- `eventsSubscribe` is a scoped Effect: the subscription is released with its scope, and reconnect/resume stays inside the adapter.

Rejected alternatives: a `Promise`-based interface (breaks the workflow Effect conventions and prevents scope-owned subscriptions); keeping the existing `call(...args)` shape behind an interface (leaks vendor arguments into callers); capability flags or optional methods (callers would need fallback branches for behavior the port must guarantee).

### Decision 2: Errors stay classifiable by the existing policy

`MultiplexerError` is an `Error` subclass with `kind: "absent" | "unavailable" | "denied" | "invalid-response" | "ownership-lost"` and the runtime identifier. The runner's mapping keeps today's classes: `unavailable`/`denied` become `TransientFailure` (the same infrastructure flavor Herdr boundary failures have today), `absent` is handled by the caller as confirmed absence, `invalid-response` fails as an error rather than a silent default, and `ownership-lost` preserves the ownership class. Abort handling stays where it is today: the engine still throws the ownership message before and during port calls, so `classifyFailure` needs no new vocabulary. Adapters must not replace an ownership abort with a generic transport error.

### Decision 3: Selection is resolved once and injected

`factory.ts` resolves the selector from `AGENTIC_CODING_MULTIPLEXER` then top-level `multiplexer` configuration, defaulting to `herdr`, and validates it through the existing configuration schema. The selected port is constructed at the application roots (workflow drain/CLI entry, server operations, notification/tab synchronization owners) and passed down; no call site re-reads the selector. An unavailable runtime produces a startup diagnostic naming the runtime and the missing prerequisite, and no fallback construction happens. Because the port is injected rather than rediscovered, tests substitute a fake port without touching process environment.

### Decision 4: Mounting surface and configuration key

Configuration surface:

```json
{ "multiplexer": "herdr" }
```

`AGENTIC_CODING_MULTIPLEXER` overrides it. The selector is deliberately a top-level scalar rather than a nested object: there is exactly one runtime choice and no per-runtime options at this stage. Luvus session/socket values are not duplicated into application configuration; the adapter reads `LUVUS_SESSION`, `LUVUS_SOCKET_PATH`, and `LUVUS_HOME` from the environment, exactly as the Herdr adapter reads `HERDR_BIN_PATH` and `HERDR_SOCKET_PATH`. The detached drain allowlist in `src/workflow/cli/drain.ts` gains `AGENTIC_CODING_MULTIPLEXER` and the `LUVUS_*` connection variables so a detached child resolves the same runtime as its parent.

### Decision 5: Migration order keeps Herdr green at every step

1. Add `port.ts`, move the Herdr CLI/schema/lifecycle into `src/multiplexer/herdr/*` with a deprecated `HerdrPort` re-export, and prove behavior with the existing focused tests plus the unchanged smoke scripts.
2. Add the factory, config key, and validation, still Herdr-only.
3. Migrate callers one module at a time behind the port: `workflow/adapters.ts` and `effect-runner.ts` (launch/reuse/stop, workspace and worktree setup, notification effect, workspace close), then `cli/pane.ts`, `tab-sync.ts`, `notification-sync.ts`, then `server/operations/observations.ts` and `server/herdr-events.ts`, then the drain boundary.
4. Add the Luvus adapter and run the shared conformance suite against both.

Each step is independently revertible; the Herdr path is never left in a half-migrated state where a caller mixes raw Herdr calls with port operations for the same intent.

### Decision 6: Testing strategy

- A shared conformance suite parameterized over both adapters asserts port semantics: normalized identities, absent-versus-unavailable classification, `worktreeCreate` identity pairing, agent status vocabulary, notification outcomes (shown/dismissed/disabled/unknown), and scope-released event subscription with reconnect.
- Per-adapter tests assert the exact vendor request: Herdr command argument arrays and Luvus UHP method/params, so "intent-level" callers cannot drift into vendor-specific behavior.
- Migrated callers are tested through a fake port: pane allocation geometry and reuse, tab label reconciliation, notification obligation transitions, dashboard observation and event refresh, and drain environment forwarding.
- The existing `scripts/test-herdr-manager.sh` and `scripts/test-herdr-workflow.sh` run unchanged as the behavior-preservation oracle for the default runtime, alongside `bun run type-check` and `bun run lint`.

## Risks / Trade-offs

- [Luvus notification delivery requires the `admin` scope (`ui.notification.push`); a restricted local session may refuse it] -> Delivery refusal is already a bounded diagnostic that never fails a workflow, and the adapter treats unauthorized/refused delivery as a recorded outcome rather than a retry loop.
- [Luvus exposes executable identities without arguments, so a shell-readiness predicate cannot be a literal port of Herdr's foreground-process check] -> The readiness predicate lives inside the adapter, uses `pane.processes` plus bounded polling, and keeps the loud "pane did not reach foreground shell" failure instead of a silent success.
- [Luvus pane ids are numeric strings while workspace/tab ids are opaque strings; a caller could assume numeric or stable shapes] -> All identities cross the port as opaque strings; the conformance suite asserts that no caller parses or constructs them.
- [Moving `HerdrPort`/`HerdrLifecycle` risks behavioral drift in the default runtime] -> The move is mechanical, `decodeHerdrResult` retains its bounded error text, and the unchanged smoke scripts plus the existing focused Herdr tests gate the step.
- [Two runtime paths could double the maintenance of pane-geometry and naming logic] -> Geometry, naming, and the layout-traversal focus loop stay in exactly one place per runtime behind `paneLayout`/`paneFocus`; nothing in the port encourages reimplementation in callers.
- [Switching the selector while workflows are running leaves their workspaces on the previous runtime] -> Documented as unsupported: the selection is process-scoped, workflows keep their recorded workspace identity, and an unreachable workspace fails loudly rather than being recreated on another runtime.

## Migration Plan

Rollout is the order in Decision 5; the default remains Herdr throughout, so no user action is required. Rollback is per step: reverting the Luvus adapter and the config key restores a Herdr-only tree, and reverting the caller migration restores direct Herdr calls while the adapter modules remain harmless. Existing workflows need no data migration: workspace ids, agent names, run handles, and pinned profiles keep their current meaning.

## Open Questions

- Which Luvus presentation class should map to the port's needs-attention urgency (`ui.notification.push --level`); the adapter can start with the warning level and adjust without changing the port contract.
- Whether the dashboard event path should prefer `events.subscribe` sequence resume or the `terminal.backend.events.subscribe` stream; the design assumes `events.subscribe` with `after_sequence` resume, and the scoped subscription contract is unchanged either way.
