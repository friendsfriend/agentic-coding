# Design: agent compaction for pi-durable workflow runs

## Context

Durable runs are hosted by `DurableHost` (`src/agent-host/host.ts`), one host
process per workflow runtime directory, opened by
`runAgentHost`/`loadAgentHostSettings` (`host-main.ts`) and reached over the
private NDJSON control protocol (`protocol.ts`, `client.ts`). The same host
class serves workflow runs and, in orchestrator mode (`--orchestrator`), the
Home → Orchestrator session; both render through the same `AgentSessionView`.

What exists today:

- **pi-durable implements compaction fully.** `CompactionPolicy` is
  `{ enabled, reserveTokens, keepRecentTokens, backgroundTokens }`; generation
  preparation compacts when the request exceeds
  `contextWindow - reserveTokens` (blocking) or, `backgroundTokens` below that,
  in the background; a provider `context too long` answer compacts once and
  retries (`reason: "overflow"`); `conversation.compact(instructions, context)`
  admits a conversation-owned manual task that summarizes while the conversation
  keeps working and places the summary at the next boundary. `enabled` gates
  threshold and overflow compaction and **not** manual compaction. Package
  defaults (`DEFAULT_COMPACTION_POLICY`, exported from the package root):
  `enabled: true`, `reserveTokens: 16384`, `keepRecentTokens: 20000`,
  `backgroundTokens: 32768`.
- **Nothing sets the policy.** `AgentHostSettings.compaction` exists
  (`settings.ts`) and `host.ts` forwards it, but `seedAgentHostSettings` seeds
  only `defaultProvider`/`defaultModel`/`defaultThinkingLevel` from the user's
  global pi settings, so `agentHost.compaction` has to be hand-written into
  `config.json` for any policy to exist. Workflow runs therefore get
  pi-durable's package defaults and there is no way to see or change them.
- **Settings cannot edit numbers.** Settings sections render `SettingsItem`
  rows whose actions are `theme-picker` / `navigate` / `retry` /
  `browser-install`; the only editing surface is the Agent Presets inline form,
  which has `text`/`select`/`action` fields and no numeric field. The
  inventory (`catalog.ts`, `SETTINGS_INVENTORY`) drives both the section
  rendering and the docs mirror, and a test asserts every inventoried entry
  reaches a rendered item.
- **Settings already has a server-owned `[agents]` write path**
  (`applyAgentsMutation` → `saveAgentsSection`, revision-checked, target file
  selected by precedence) and a GET status read (`loadAgentConfig`).
- **The durable runtime telemetry already subscribers to pi-durable's event
  stream** (`telemetry.ts`, `watchEvents`) and maps `turn_start`,
  `tool_execution_start`/`_end`, `message_end`, `run_end` and `task_failed`.
  `compaction_start`/`compaction_end` are **not** mapped today, although the
  `durable-agent-tools` spec already requires a compaction envelope.
- The dashboard shows `Compacting context` blocks from `pi.live.compactions`
  and the Agents-panel activity already reads `compacting` from the same
  document, but neither knows the reason, the tokens before/after, or the
  outcome.

Key pi-durable facts this design relies on:

- `HarnessSettings` is documented as "read at every resolution and never
  copied; getters are fine". `Harness.open(storage, { settings })` stores the
  object and `resolveSettings(options.settings)` is called per resolution
  (`harness.js`), so a **getter** on the settings object we pass is re-read for
  every generation — the host's snapshot-at-open does not prevent live values.
- The policy is **harness-wide**, not per conversation: one host serves every
  run of a workflow, and runs of one workflow may use different models (per-
  profile model selection plus live `/model` overrides). pi-durable never asks
  the caller for a per-conversation policy, and `resolveSettings` merges the
  policy into a plain resolved object.
- `conversation.compact(instructions, context)` returns a `TaskId`. It is
  conversation-owned but **not** background (`background: false` for
  `reason: "manual"`), so it survives on its own but is cancelled by
  `conversation.abort()` — which `/abort` calls. When no cut can be selected
  (`selectCut` returns `undefined`) the task completes immediately with an empty
  result and never appears in `pi.live`.
- The committed compaction entry is a `pi.compaction` entry carrying only
  `{ reason }`, and `CompactionStatus` carries `{ taskId, reason, blocking,
  attempt, retry? }`. **pi-durable records no token counters for a
  compaction**, so "tokens before/after" must be measured from the
  conversation's own assistant usage around the compaction.
- `estimateContext`/`selectCut` are not reachable through the package export
  map (only `CompactionTask`, `CompactionPolicy`, `CompactionStatus`,
  `CompactionEntry`, `DEFAULT_COMPACTION_POLICY`, `LiveDoc`, `watchEvents`,
  `Conversation`) — so the host measures tokens from usage, not by calling
  into the package's internals.

## Goals / Non-Goals

**Goals:**

- `/compact [instructions]` works from the agent session prompt for both
  durable workflow runs and the orchestrator session, with an honest outcome
  for every case (started, already compacting, nothing to compact, run
  finished, failed) and visible feedback in the transcript and status.
- A concrete, defensible default compaction policy for durable runs, editable
  in Settings, validated, stored in the canonical layered configuration, and
  effective for running conversations without restarting the host.
- Compaction is observable: a durable runtime telemetry envelope per
  compaction with reason, blocking flag, attempts, duration, measured tokens
  before/after and the error class when it failed.

**Non-Goals:**

- Per-role / per-preset / per-profile compaction policies (pi-durable offers no
  per-conversation policy — see Open Questions).
- Compaction for pane runtimes (`pi`, `opencode`, `opencode-v2`): they compact
  themselves, and `/compact` stays a durable-session command.
- Changing compaction semantics inside pi-durable (no upstream patch, no
  monkey-patching): the plan only configures and drives what the pinned version
  offers.
- Any workflow-store or environment-state schema change.

## Decisions

### D1. Compaction policy lives in `[agents.compaction]`, user scope

**Decision.** The four values live under `[agents.compaction]` in the canonical
layered workflow configuration (`config.json` under the resolved config root,
`HERDR_WORKFLOW_CONFIG` honored), as a user-scope setting:

```json
{ "agents": { "compaction": {
  "enabled": true,
  "reserveTokens": 32000,
  "backgroundTokens": 32000,
  "keepRecentTokens": 20000
} } }
```

`agentHost.compaction` keeps precedence when it is present (a hand-written
escape hatch today), and `Settings` shows which of the two supplied the
effective value.

**Why.** `agents` is the section the Settings server write path
(`applyAgentsMutation`/`saveAgentsSection`), the revision check and the GET
status read already own, so a Compaction section reuses the existing
persistence, conflict and stale-write machinery instead of inventing a second
config writer. `agentHost` is a durable-host-only section read by a bare JSON
read with no layering, no schema and no writer.

**Why user scope.** The host process has no repository context (`host-main.ts`
resolves the config path, not a project), and a project overlay must not be able
to change how a workflow's own runs compact without the operator seeing it. So:
the section is user scope, the write path is pinned to the user-level file, and
the host resolves the same user-level document. `saveAgentsSection` gains an
explicit user-scope mode (`{ userScope: true }`) that skips the project-overlay
candidate, so a repository's `[agents]` overlay can never capture the write; an
overlay's `agents.compaction` is ignored (reported as such by the section).

### D2. Absolute values are the default; percentages are an opt-in form with a fallback

Each token field accepts either a non-negative integer (absolute tokens) or a
string percentage of the model's context window (`"15%"`). Resolution is one
pure function:

```
resolveCompactionPolicy(config, referenceWindow?) -> CompactionPolicy
```

- Defaults: `enabled: true`, `reserveTokens: 32000`, `backgroundTokens: 32000`,
  `keepRecentTokens: 20000` (rationale in `proposal.md`).
- An absolute value is used as given; `"N%"` becomes
  `round(referenceWindow * N / 100)` when a reference window is known, and
  otherwise falls back to the field's absolute default (the documented
  fallback).
- Floors and clamps, applied after the form is resolved: `reserveTokens` ⌈4096⌉,
  `keepRecentTokens` ⌈4096⌉, `backgroundTokens` ⌈0⌉ (`0` disables background
  compaction); when a reference window `W` is known, `reserveTokens` is clamped
  to `W / 2` and `keepRecentTokens` to `max(4096, W - reserveTokens - 1024)` so
  a bad configuration can never make the policy self-defeating.
- The result is always a complete `CompactionPolicy` (pi-durable merges it over
  its own defaults anyway).

**Why not percentages everywhere.** `reserveTokens`/`backgroundTokens` are
already applied *relative to the actual window* (`blocking = contextWindow -
reserveTokens`), and the reserve also bounds the summarizer's own output budget
(`0.8 × reserveTokens`), so an absolute reserve is both safer and
self-scaling; a percentage reserve would ask for 250k summarizer output on a 1M
window. `keepRecentTokens` is different: it is the verbatim tail, and a fixed
20k is 16% of a 128k window but 2% of a 1M window, which is why the percentage
form exists and is the recommended form for large windows.

### D3. The reference window is derived from the host's tracked runs

`DurableHost` records the model of each conversation it tracks: `ensureRun`
(creation and configuration) and `configureRun` (live `/model`) both know it,
and the conversation's own `pi.agent` document is the fallback. The reference
window is the **minimum** `contextWindow` among those model refs, resolved
through the host's model catalog (`this.models`); with no known model, the
percentage falls back to the absolute default.

**Why the minimum.** With one harness-wide policy, the smallest window in play
is the one that must stay safe: a policy sized for the largest window would
start compacting too late for the smallest one. The cost is conservatism — a
1M-window run in a workflow that also runs a 128k model gets the 128k-derived
policy — which the design states plainly and the Settings rows display ("of
`128k` reference window").

### D4. The policy is resolved live, through a getter

`host-main.ts` wraps the resolved section in an accessor and `host.ts` forwards
it to `Harness.open` as a getter instead of spreading it once:

```ts
settings: {
  get compaction() { return this.compactionPolicy(); },   // host.ts
  ...retry/steering snapshots (unchanged)
}
```

`compactionPolicy()` returns the cached resolution, recomputed when the
configuration file's mtime/size changes or the tracked-run model set changes.
Because pi-durable calls `resolveSettings(options.settings)` per resolution,
a Settings save reaches a **running** conversation without a host restart.

**Why a getter rather than re-opening the harness.** Re-opening per change would
drop the in-memory run map and the measured entry timings and would race the
single-writer lock. The getter is the mechanism pi-durable documents for exactly
this.

**Trade-off.** A policy change mid-run can move the threshold under a running
conversation, which may trigger a background compaction the developer did not
expect. Accepted: it is one summarizer call, the change is explicit, and the
alternative (host restart) loses more.

### D5. Manual compaction is one protocol request with a structured outcome

```ts
// protocol.ts
export interface CompactRunRequest {
  readonly type: "compactRun";
  readonly runId: string;
  /** Free-text summarizer instructions; bounded (2000 chars) and trimmed. */
  readonly instructions?: string;
}
export interface CompactRunResponse {
  readonly type: "compactRun";
  readonly runId: string;
  readonly status: "started" | "already-compacting" | "nothing-to-compact";
  readonly taskId?: string;   // when started
  readonly reason?: string;   // the reason of the compaction already running
}
```

Host method `compactRun(runId, instructions?)`:

1. `requireConversation(runId)` — an unknown or torn-down run throws
   `unknown run: …`, which the existing error mapping turns into the
   `unknown-run` error code (the "run has finished" path).
2. Read the conversation view once. A non-empty `pi.live.compactions` returns
   `already-compacting` with that status's reason **without** admitting a second
   task.
3. `conversation.compact(instructions, BACKGROUND_CONTEXT)`.
4. Read the view again: the task id still listed in `pi.live.compactions` →
   `started`; not listed → `nothing-to-compact` (the compaction selected no cut
   and completed immediately). Best-effort by construction, and that is what
   both the response and the transcript say.

`/compact` is offered **while a session is open**, including for a read-only
run: compaction rewrites the conversation's context, not the repository, and a
verifier's transcript grows like anyone else's. A finished run has no live
session to serve it and is refused locally and by the host.

### D6. Feedback is derived from documents the host already publishes

No new state is introduced for feedback; the pieces come from what runs already
carry:

- **Running**: `pi.live.compactions` (`reason`, `blocking`, `attempt`,
  `retry`). The transcript's live block becomes `Compacting context (manual)…`
  / `(automatic)…`, and the status line shows a `compacting` indicator with its
  reason; a retry backoff in the status shows as `compacting (retrying)`.
- **Finished**: the committed `pi.compaction` entry (`reason`) plus the
  measured token movement: tokens before = the newest assistant prompt tokens
  (input + cache read + cache write) committed *before* the compaction entry,
  tokens after = the first such usage *after* it. Both are read from the
  conversation's own entries in `agent-session.ts`, exactly like the existing
  context meter, and omitted when unavailable (a host restart, or a compaction
  whose summary has not been followed by a generation yet).
- **Failed**: pi-durable fails the compaction *task*; the failure surfaces
  through the existing `task_failed` event (kind `pi.compaction`) and, on the
  dashboard, through the run's error row. The view shows
  `Compaction failed: <bounded error>` and the presence of the live status
  disappears with it.
- **`/abort` also cancels a manual compaction** (it is a non-background
  conversation-owned task). Stated in the design and covered by a test rather
  than hidden: after `/abort`, the transcript shows the compaction as aborted
  and no summary is placed.

### D7. Telemetry: one envelope per compaction, measured from the event stream

`telemetry.ts` gains `compaction_start`/`compaction_end` handling: it records
`{ reason, blocking, attempt, startedAt }` per task id and emits

- `runtime.compaction_start` — `reason`, `blocking`, `attempt`;
- `runtime.compaction` — `reason`, `blocking`, `attempts`, `durationMs`,
  `tokensBefore`/`tokensAfter` (when measured from `message_end` usage around
  the compaction), and `outcome` (`completed` | `failed` | `aborted`) with a
  redacted, bounded error class from a correlated `task_failed`.

Names follow the existing durable envelopes (`runtime.usage`, `runtime.tool`)
and the pi bridge's own `runtime.compaction` event, so the dashboard's existing
telemetry consumers and the OTLP receiver need no change.

### D8. Settings: a new `Compaction` section with the first numeric editor

- `routes.ts`: `settings.compaction` page, `SETTINGS_SECTIONS` entry, label
  `Compaction`, description, `PAGES` entry.
- `catalog.ts`: inventory entry `agents.compaction` (owner
  `src/workflow/compaction.ts`, scope `user`, storage
  `` `[agents.compaction]` in the layered workflow config ``, effect
  `immediate` — the host re-reads it at every resolution), plus its mirror row
  in `docs/settings-inventory.md`.
- `items.ts`: `compactionItems(context)` renders `compaction.enabled` (on/off)
  and one row per token field showing the effective policy
  (`32000 tokens · default`, `15% of 128k → 19200 tokens`), the resolved
  reference window, and the source (`[agents.compaction]` or the
  `agentHost.compaction` override).
- New action `{ kind: "numeric-edit"; field: "reserveTokens" | … }` and one
  bounded numeric editor overlay (`src/tui/settings/NumberEditor.tsx`) shared by
  the four rows: digits with an optional trailing `%`, per-field bounds,
  inline validation message, Enter to save, Esc to cancel. Reasonable because
  Settings has no numeric editor today and the Agent Presets form's `text` field
  cannot express "integer or percentage within bounds".
- Persistence: a new `set-compaction` `AgentsMutation`
  (`src/server/config.ts`), validated by the pure validator from
  `src/workflow/compaction.ts` (rejected values are a `400` naming the field),
  written through `saveAgentsSection` in user-scope mode, revision-checked like
  the other mutations.
- Read side: the agents status response (`AgentConfigRead` via
  `loadAgentConfig`) gains
  `compaction: { effective, configured, source, validation, referenceWindow? }`,
  and `SettingsContext.agents` carries it to the section.

## Risks / Trade-offs

- [One harness-wide policy cannot follow per-run models] → D3 resolves
  percentages against the smallest tracked window and the section shows that
  reference window, so the operator sees the conservatism. A per-run policy is
  an Open Question, not a silent approximation.
- [A mid-run Settings save can trigger an unplanned compaction] → D4 accepts it;
  the change is explicit, bounded to one summarizer call, and the transcript
  shows the reason. Editing while `enabled` is off is impossible to trigger.
- [Manual compaction is cancelled by `/abort`] → Stated in the docs and covered
  by a test; the transcript shows the aborted compaction instead of a summary.
- ["Nothing to compact" is inferred, not returned] → The check is best-effort by
  construction (pi-durable completes such a task immediately and reports no
  reason); the response and the notice say "nothing to compact" only when the
  task is genuinely not listed, and a started compaction is never reported as
  nothing.
- [A project overlay's `agents.compaction` is ignored] → User scope is explicit
  in the inventory, the section and `docs/settings-inventory.md`; the section
  reports the source of the effective value, and per-scope compaction is a
  follow-up.
- [Settings has no numeric editor, so this adds a new interaction to the
  Settings surface] → Keep the editor minimal (one overlay, four rows,
  per-field bounds, validation message), covered by the existing Settings page
  tests plus focused editor tests, and no other section gains a new action kind.
- [A percentage value with no resolvable window silently falls back] → The
  fallback is the documented absolute default and the section shows the resolved
  effective value, so what the host will use is always visible.
- [Touching `HarnessSettings` forwarding could change retry/steering behavior] →
  Only `compaction` becomes a getter; `retry`/`steeringMode`/`followUpMode`
  keep their current snapshot semantics, and an existing test asserts the
  forwarded shapes.

## Migration Plan

No persisted format changes and no data migration. The section is additive:
absent `[agents.compaction]` resolves to the new defaults, and a hand-written
`agentHost.compaction` keeps winning, so existing installations change behavior
only in that automatic compaction now uses the reviewed defaults instead of
pi-durable's package defaults. Rollback is removing the section (defaults
revert) or setting `enabled: false` (manual compaction still works).

## Open Questions

1. **Default values.** The recommendation is `enabled: true`,
   `reserveTokens: 32000`, `backgroundTokens: 32000`, `keepRecentTokens: 20000`
   (absolute), with `"15%"` recommended for large-window operators. The
   developer should confirm the reserve/background magnitudes and whether
   `keepRecentTokens` should default to the percentage form.
2. **Per-role policy.** Should a long-lived orchestrator session keep more
   context verbatim than a short-lived worker (or the other way round)? Not
   expressible today; needs either an upstream pi-durable per-conversation
   policy or a per-role host split.
3. **Enabled by default for every role.** The recommendation is yes (a run that
   overflows dies, and compaction is the only recovery); the alternative is to
   enable it for long-running roles only.
4. **Should `/compact` also be offered for a run whose conversation the host no
   longer tracks** (a recovered watch by `conversationId`)? Today it is refused
   with `unknown-run`; admitting it would need a new host path that resolves a
   conversation without a tracked run.
