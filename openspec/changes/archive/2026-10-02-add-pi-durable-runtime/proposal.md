## Why

Managed agents currently run as the interactive `pi` coding-agent TUI inside a Herdr pane: prompts are typed into the terminal, status is inferred by the multiplexer, and a crashed or killed agent loses its in-flight turn. Pi 1.0 ships `@earendil-works/pi-durable`, a durable harness (SQLite-checkpointed conversations, crash resume, exactly-once submissions, multi-client attach). Hosting agents on it — bundled inside the `agentic-coding` executable — removes the external `pi` dependency for the default route, gives the engine idempotent prompt delivery and crash recovery, and is the first step toward retiring multiplexer-hosted agents in favour of an OpenTUI agent view in the dashboard.

## What Changes

- Add a bundled, headless **durable agent host** (`agentic-coding agent host …`, internal mode of the same executable) built on `@earendil-works/pi-durable`, pinned to exact versions together with `@earendil-works/pi-ai`, `@earendil-works/chord`, and `@earendil-works/pi-coding-agent` (used only for its model runtime/credential and settings readers).
- One detached host process and one SQLite storage **per workflow**; every agent run is a conversation in it, persistent roles reuse their conversation, and a restarted host resumes interrupted work from storage.
- A private, permission-restricted Unix-socket control protocol (submit with `requestId` exactly-once, status, abort, stop, view snapshot + watch updates) used by the engine adapter and by the dashboard.
- New runtime id **`pi-durable`** with a `PiDurableAdapter` that launches/prompts/observes/stops through the host instead of a multiplexer pane; the engine skips pane allocation for runtimes that host their own process.
- Port the workflow's pi extensions to native durable extensions: `developer_question`, `agent_ask`, `ask_jev`, the telemetry bridge (as hooks emitting the existing envelope with runtime `pi-durable`), plus the coding tools, a read-only tool policy, and a system prompt that includes `AGENTS.md` context and the working directory.
- Own durable-agent settings section in the agentic-coding configuration, seeded once from the relevant parts of the user's global pi settings (default provider/model/thinking, compaction, retry); credentials and custom models are read **live** from the user's global pi agent directory (`auth.json`, `models.json`) so the user configures them once.
- Dashboard: **Enter** on a `pi-durable` agent in the Agents panel opens an OpenTUI agent session view (transcript, streaming answer, tool progress, queue, status) with an input to steer / queue a follow-up and a key to abort; keybind catalogs updated.
- **BREAKING (default behaviour):** the built-in `use-default-model` preset harness defaults to `pi-durable`. The `pi` runtime remains selectable as a legacy runtime; its retirement is a follow-up change.
- Out of scope (follow-up drafts): `retire-native-pi-runtime`, `remove-multiplexer-agent-hosting`, `pi-durable-codemode-parity`.

## Capabilities

### New Capabilities
- `durable-agent-host`: bundled per-workflow durable harness process — storage location, single-writer lock, detached lifecycle, Unix-socket control protocol, run conversations and per-run environment, crash resume, stop/cleanup.
- `durable-agent-tools`: tool and prompt surface of a durable agent run — coding tools, read-only policy, workflow question/peer/judgment tools, system prompt context, telemetry hooks.
- `durable-agent-configuration`: durable-agent settings section seeded from global pi settings, live global credentials/models, model enumeration for preflight.
- `dashboard-agent-session-view`: dashboard subview for a durable agent run opened from the Agents panel, with steering, follow-up, and abort.

### Modified Capabilities
- `agent-runtime-routing`: adapters requirement adds the `pi-durable` runtime that runs without a multiplexer pane; model availability preflight enumerates `pi-durable` models in-process.
- `default-model-preset`: supported harness list includes `pi-durable`, which becomes the built-in preset's default harness.
- `unified-application-distribution`: the single executable also embeds the durable agent host so the default route needs no external agent executable.

## Impact

- **Code:** `agentic-coding/src/agent-host/` (new: host, protocol, client, tools, prompt, telemetry, settings), `src/workflow/adapters.ts`, `src/workflow/operations.ts`, `src/workflow/effect-runner.ts` (pane-less launch path), `src/workflow/profiles.ts` (runtime id, preset default, model enumeration), `src/contracts/workflow.ts` (`RuntimeId`, optional pane in handle), `src/cli.ts` (internal `agent host` mode), dashboard Agents panel/keybinds and a new route, settings TUI runtime choices, `pi/herdr-workflow.json`, README and `docs/workflow-architecture.md`.
- **Dependencies:** `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord`, `@earendil-works/pi-coding-agent` at exact `1.0.0` (experimental API; upgrades are deliberate). A spike confirmed they run under Bun 1.4 (`node:sqlite`) and compile into a `bun build --compile` binary that runs outside any checkout.
- **Systems:** Herdr is no longer involved for `pi-durable` runs (still used for workspaces and for `pi`/`opencode` runs). The user's `~/.pi/agent` (or `PI_CODING_AGENT_DIR`) stays the credential source; no secrets are copied.
