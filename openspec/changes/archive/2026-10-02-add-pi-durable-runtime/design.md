## Context

- Today every `pi` route launches the interactive pi coding-agent TUI inside a Herdr pane (`PiAdapter` in `src/workflow/adapters.ts`): the engine creates a pane, `herdr agent start --kind pi` execs a per-run `pi` wrapper, the assignment is typed in with `herdr agent prompt`, status (`idle|working|blocked|done|unknown`) is inferred by Herdr, and three pi extensions are loaded with `--extension`: `agent-definitions/extensions/developer-question.ts` (`developer_question`, `agent_ask`), `agent-definitions/extensions/ask-jev.ts`, and the `agent-definitions/bridges/pi-telemetry.ts` bridge.
- `@earendil-works/pi-durable@1.0.0` (experimental, MIT) is a library, not a CLI. Pi's own durable coding agent (`packages/coding-agent/src/experimental/durable`) is excluded from the published package and imports unexported pi internals, so it cannot be launched or reused directly; the repository has to host the harness itself. Useful upstream references: `packages/durable/README.md` and `packages/durable/test/examples` (notably `13-recovery`, `20-inbox`, `21-late-join`, `26-coding-agent`, `31-reload-and-restart`, `07-configuration`).
- Spike results (performed outside the repository): pi-durable + pi-ai + chord run under Bun 1.4.2 with `openNodeSqliteStorage` (`node:sqlite` works under Bun); a faux-model turn using `bash` and a custom tool completed; `bun build --compile` of that harness produced a binary that runs from `/` with no `node_modules`; `ModelRuntime`/`SettingsManager` (public exports of `@earendil-works/pi-coding-agent`) also compile in and read the user's existing `~/.pi/agent` auth/settings.
- Developer direction (plan dialogue): long-term the multiplexer stops hosting agents and the dashboard shows agent feedback in an OpenTUI view opened with Enter from the Agents panel; `pi-durable` becomes the built-in default with `pi` kept as legacy; one host per workflow; credentials are read from the user's global pi configuration (configure once), other relevant settings live in agentic-coding's own configuration seeded from the global one.

## Goals / Non-Goals

**Goals:**
- Run managed agents on pi-durable inside the single `agentic-coding` executable, with no external agent binary for the default route.
- Exactly-once prompt delivery and crash resume for agent runs.
- Feature parity for the workflow protocol: assignment/handoff, `developer_question`, `agent_ask`, peer-question prompts, `ask_jev`, read-only policy, telemetry envelopes, model preflight.
- Human visibility and steering through a dashboard agent session view.

**Non-Goals:**
- Removing the `pi` runtime, `pi-tools.ts`, `agent-extension`, or pi-sessions integration (follow-up `retire-native-pi-runtime`).
- Removing Herdr agent hosting for `opencode`/`opencode-v2` or Herdr workspaces (follow-up `remove-multiplexer-agent-hosting`).
- `codemode`/`tool_search` and user pi extensions inside durable runs (follow-up `pi-durable-codemode-parity`).
- OAuth login UI; users keep logging in with their existing pi configuration or API-key environment variables.
- Remote/multi-machine hosts, forks/tree navigation, subagent tools.

## Decisions

### D1. Bundle the host as an internal mode of the existing executable
`agentic-coding agent host --workflow-dir DIR` is a hidden internal subcommand of `src/cli.ts`; the engine spawns `process.execPath` (compiled) or `bun src/cli.ts` (source checkout) with that mode, detached, stdio to a host log file. Code lives in `agentic-coding/src/agent-host/` (host, protocol, client, tools, prompt, telemetry, settings).
- *Why:* the spike proved bundling works; one artifact keeps `unified-application-distribution`'s single-executable rule and needs no install step.
- *Alternatives:* a separate `pi-durable` binary (second artifact, version drift); vendoring pi's experimental durable agent (unexported internals, churn).

### D2. One detached host and one SQLite storage per workflow
Storage, socket, lock, and log live under the workflow's runtime directory (resolved through `src/workflow/paths.ts`, e.g. `<workflow runtime dir>/agent-host/{harness.sqlite,host.sock,host.lock,host.log}`), directory mode `0700`. Each run is a conversation created with `ownership: ownerless` and keyed by run id in an app document (`agentic.run`); persistent roles reuse the conversation of their role. The host keeps a single-writer lock (pi-durable requires one process per storage); a second start detects the live owner and exits. On start the host calls `harness.resume()`.
- *Why:* matches pi-durable's many-conversations model, one process per workflow instead of per agent, and agents outlive a bounded `workflow drain` and the dashboard exactly as panes do today.
- *Alternatives:* per-run host (more processes, no shared view); in-process in the engine/dashboard (dies with the bounded drain/TUI).

### D3. Private Unix-socket control protocol (newline-delimited JSON)
Requests: `hello` (protocol version, host id), `ensureRun` (run id, cwd, model, thinking, tool policy, run.env path, name), `submit` (run id, text, `requestId`, `whenBusy: steer|followUp`), `status` (run id → `idle|working|blocked|done|unknown`, last error), `abort` (run id), `stopRun` (run id), `shutdown`, `watch` (run id → initial `viewState` snapshot, then full-value frames coalesced by the host, bounded rate). Socket file mode `0600` in the `0700` directory; the host rejects frames above a byte bound and unknown versions. `requestId` = the effect idempotency key, so a retried prompt effect returns the original submission.
- *Why:* tiny, testable, no new protocol stack; full-value frames are simple for the dashboard and bounded by pi-durable's watch coalescing.
- *Alternatives:* `@earendil-works/pi-server`/`pi-client`/`pi-protocol` (CBOR + Chord service layer, also experimental, much more surface) — revisit when multiplexer hosting is removed.

### D4. `pi-durable` runtime adapter without a pane
`RuntimeId` gains `"pi-durable"`; `PiDurableAdapter` implements `AgentAdapter`: `preflight` checks capabilities (no executable lookup), `launch` ensures the workflow host is running (spawn if the lock is free), sends `ensureRun` then `submit` with the rendered assignment, `prompt` submits with a stable `requestId`, `observe` maps `status`, `stop` sends `stopRun`. The adapter declares `hostsOwnProcess`, and the launch handler in `effect-runner.ts` skips pane allocation/closing for such adapters; `AgentHandle.paneId` becomes optional and a durable handle carries `hostSocket` + `conversationId` instead. When `observe` finds no live host, the adapter restarts the host over the same storage (resume) once per observation before reporting `unknown`, so a crash does not block the run.
- *Why:* keeps the engine's adapter seam; the only engine change is a capability-gated pane-less path.
- *Alternatives:* launching through Herdr with a `pi` wrapper (Herdr status heuristics would not recognise the process and prompts would stay non-idempotent).

### D5. Native durable extensions replace the pi extensions
- Coding tools: `CodingTools` (read, write, edit, bash). Read-only policy removes `edit`/`write` via the conversation's tool selection (bash stays, same contract as pi's `read,bash`).
- `developer_question` and `agent_ask`: same parameter schemas and descriptions as `developer-question.ts`, executing `agentic-coding workflow question|ask` with the run environment; `replay` unset (interrupted calls are reported to the model, never repeated).
- `ask_jev`: same contract as `ask-jev.ts` including the "in-session judgment unavailable" answer when `AGENTIC_JEV` is absent; `replay: "safe"` (read-only judgment).
- Per-run environment: the `env` factory reads the run's `run.env` file path from the run document and builds `NodeExecutionEnv({ cwd, shellEnv })`, so `HERDR_*`, the run capability, `AGENTIC_JEV`, and telemetry variables reach `bash` and the workflow tools per conversation without the host process holding them globally.
- Prompt extension: sections for a base coding-agent preamble, the tool list, `AGENTS.md`/`CLAUDE.md` context files from the run cwd up to the repository root and the global pi agent dir, and the cwd/date.
- Telemetry: hooks (`afterResponse`, `beforeTool`/`afterTool`, compaction, settle) emit the existing envelope (`schemaVersion 1`, `layer runtime`, `runtime "pi-durable"`) to the run's `HERDR_TELEMETRY_PATH` and OTLP endpoint, with the same redaction and `HERDR_CAPTURE_CONTENT` opt-in as `pi-telemetry.ts`; the shared redaction/envelope helper is extracted rather than duplicated.

### D6. Configuration and credentials
- Credentials and custom models are read live: `ModelRuntime.create({ authPath, modelsPath })` pointed at the global pi agent dir (`PI_CODING_AGENT_DIR` or `~/.pi/agent`), so pi's own locking and OAuth refresh apply and nothing secret is copied.
- Settings: a new `agentHost` section in `config.json` (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `compaction`, `retry`, `steeringMode`, `followUpMode`). On first use when the section is absent it is seeded once from the matching keys of the global pi `settings.json`; afterwards it is owned by agentic-coding. Harness settings are getters over this section.
- A profile's `model` (with optional `:thinking` suffix) overrides the default; `use-default-model` passes none and the configured default applies.
- Model preflight for `pi-durable` enumerates `ModelRuntime` available models in-process instead of shelling out.

### D7. Dashboard agent session view
Enter on an Agents-panel row whose handle runtime is `pi-durable` opens a new dashboard route (`routes/AgentSessionRoute.tsx`) instead of focusing a pane; other runtimes keep pane focus. The route attaches via the socket `watch`, renders transcript entries, the streaming answer, running tools and their output, queue, model/usage and status, and offers an input (submit = steer while busy / prompt when idle; follow-up key queues) and abort. Rendering stays inside the shared OpenTUI primitives; keybinds are declared in `src/tui/dash/keybinds.ts` with a new `agent-session` context and appear in the footer and `?` help.

### D8. Dependency pinning
Exact versions (`1.0.0`) for pi-durable, pi-ai, chord, pi-coding-agent; the host imports only public entrypoints. A focused compile smoke test runs the compiled executable's `agent host` mode against a faux provider.

## Risks / Trade-offs

- [Experimental pi-durable API changes] → exact pins, all usage behind `src/agent-host/`, upgrade only deliberately with the focused tests.
- [Host crash takes all of a workflow's agents down at once] → automatic resume on next observe/launch; tools without `replay: "safe"` report interruption instead of re-running.
- [Agents lose visibility in Herdr panes] → dashboard session view in the same change; host log file for diagnostics.
- [Bundle size / startup] → spike binary was ~63 MB including the Bun runtime; host mode lazy-imports pi modules so other CLI modes do not pay the import cost.
- [Live credentials shared with pi] → read through pi's own `ModelRuntime` file locking; no copies, so token rotation cannot diverge.
- [`codemode`, skills and user pi extensions unavailable in durable runs] → documented; `pi` profile remains selectable; follow-up draft.
- [Socket exposure] → `0700` directory, `0600` socket, single-user host, bounded frames; the run capability token is never sent over the socket, only the `run.env` path the engine already writes privately.
- [node:sqlite under Bun is newer than under Node] → host test exercises SQLite storage and resume under Bun.

## Migration Plan

1. Ship the runtime; existing configurations that explicitly set the preset harness or use `pi` profiles are unchanged.
2. Fresh/unspecified preset harness resolves to `pi-durable`; running workflows keep their pinned route (routing is pinned per workflow).
3. Rollback: set `use-default-model` harness to `pi` in configuration; durable host storage is left in the workflow runtime directory and ignored.

## Open Questions

- Whether the session view should also offer model/thinking switching per run (deferred; routing pins the model).
- Retention of per-workflow `harness.sqlite` after workflow close (proposed: removed with the workflow runtime directory on close/cleanup).
