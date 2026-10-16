# Proposal

## Why

The shell's workflow monitor (`src/tui/orchestrator/monitor.ts`) is the
orchestrator's only ear, and it is all-or-nothing: it observes just the
workflows the orchestrator started, re-reads each one on every `workflow.*`
event, and hands the session either one coalesced `[workflow-monitor]` note per
minute or nothing at all (`[agents.orchestrator] monitor = wake | notify | off`).
The orchestrator cannot say what it cares about — a specific workflow, one
repository, only attention-required transitions, only failed effects — and the
workflow state it needs is not available as a typed, replayable stream to
anything else (CLI, dashboard) either.

## What Changes

- A versioned, typed **workflow event catalog** in the contract layer: stable
  event ids for workflow lifecycle, step transitions, attention, reviews,
  questions, effects/delivery, runs, verification findings, compaction, gate
  decisions, the orchestrator launch ceiling, stalled runs and OpenSpec task
  progress. Each event declares its bounded payload and whether it is
  human-needed (a decision owed to the developer).
- **Derivation moves server-side**: the unified server turns its existing
  `workflow.updated` stream into catalog events (debounced per-workflow view
  read → pure projection diff), keeps them in a bounded, cursor-addressed event
  log, and serves them on `/api/v1` (read by cursor, auth and manifest like the
  rest of v1). No second source of truth and no second event stream: `workflow.*`
  plus the workflow projections stay authoritative.
- **Orchestrator-controlled subscriptions**: new tools `subscribe_events`,
  `unsubscribe_events`, `list_subscriptions` and `read_events` (pull). A
  subscription names workflow ids, "all started by me" or a repository, event
  ids or categories, optional conditions (attention reason, roles, severity,
  minimum interval) and a delivery mode (`wake` / `digest` / `silent`), with an
  expiry or until-condition, a label and a reason.
- **Delivery** reuses the monitor's anti-storm guarantees per subscription:
  coalescing window, per-minute bound with merge-forward, de-duplication of one
  event delivered through several subscriptions (one line, all labels), bounded
  note size, a cap on subscriptions, and a hard cap on notes per window. The
  `[workflow-monitor]` note prefix stays; a note names the subscriptions that
  contributed.
- **Master switch unchanged**: `[agents.orchestrator] monitor` remains
  `wake` / `notify` / `off`; `off` observes nothing and refuses subscriptions
  with a clear error. Default behaviour with no subscriptions is today's
  behaviour, expressed as a visible, replaceable default subscription.
- **Durable, session-owned subscriptions** in a small JSON file next to the
  orchestrator conversation state (`<config root>/orchestrator/`); no workflow
  store schema change (`STORE_SCHEMA_VERSION` stays 6). Pruned on expiry, on
  workflow close and on orchestrator reset.
- **UX**: the Orchestrator page gains `/subscriptions` (list with label, filter,
  mode, expiry and last delivery, plus removal); delivered notes keep appearing
  in the transcript.

## Capabilities

### New Capabilities

- `workflow-event-stream`: the typed, versioned event catalog, its derivation
  from the existing durable workflow events/projections, the bounded
  cursor-addressed log and the v1 read surface.
- `workflow-event-subscriptions`: the subscription model (filters, conditions,
  modes, expiry), its durability and cleanup, and the delivery semantics
  (coalescing, rate limits, de-duplication, note format).

### Modified Capabilities

- `home-orchestrator`: the monitor no longer derives transitions in the shell —
  it consumes catalog events and delivers them; the orchestrator gains the
  subscription tools and `/subscriptions`; the default subscription and the
  `off` refusal are specified.

## Impact

- New: `src/contracts/workflow-events.ts` (catalog + payload schemas),
  `src/server/workflow-events.ts` (pure projection/derivation/matcher),
  `src/server/workflow-event-bus.ts` (log, registry, deriver, publish),
  `src/tui/orchestrator/delivery.ts` (pure delivery planner),
  `src/tui/data/orchestrator-events.ts`.
- Changed: `src/server/app.ts` + `src/server/protocol.ts` +
  `src/server/orchestrator-policy.ts` (routes and allowlist),
  `src/server/handlers.ts` + `src/server/lifecycle.ts` (operations and wiring),
  `src/server/gateway/inProcess.ts` + `src/server/client.ts` +
  `src/contracts/gateway.ts` (subscription reads/removal for the TUI),
  `src/tui/orchestrator/monitor.ts` (delivery client), `OrchestratorView.tsx`
  (`/subscriptions`), `src/agent-host/orchestrator.ts` (four additive tools and
  one prompt paragraph), `src/workflow/profiles.ts` (`stall_minutes`).
- Removed: `src/tui/orchestrator/transitions.ts` (its detector becomes part of
  the derived catalog). Runner inventories of the shells that no longer need a
  view read.
- Docs: `docs/orchestrator.md`, `docs/settings-inventory.md`, the orchestrator
  system prompt.
- No change to workflow behaviour, to `STORE_SCHEMA_VERSION` (6) or to any store
  schema; the feature only observes.
