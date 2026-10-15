# Proposal: agent compaction for pi-durable workflow runs

## Why

Durable (`pi-durable`) workflow runs have no compaction control at all. A long
worker/verifier run that outgrows its model's context window dies with a
provider `context too long` error, and the developer driving a live session from
the dashboard cannot ask the agent to compact its own context. `pi-durable`
already implements compaction (threshold, background, overflow retry and a
manual `Conversation.compact()`), and `DurableHost.open()` already forwards
`settings.compaction` — but nothing ever sets it: `loadAgentHostSettings()`
seeds only the provider/model/thinking keys from the user's global pi settings,
and `agentHost.compaction` must be hand-written into `config.json` to exist at
all. Manual compaction is not reachable from any surface.

## What Changes

- **Manual compaction command.** `/compact [free-text instructions]` in the
  agent session prompt (dashboard agent session view and the orchestrator
  session, which share `AgentSessionView` and the same host class) routes
  through the `agent-host` control protocol like `/model` and `/thinking` do,
  and calls `Conversation.compact(instructions, context)`. The command appears
  in the prompt's command autocomplete and its help.
- **Manual compaction feedback.** The transcript shows compaction started /
  running (with reason `manual`), finished, or failed, and the session status
  line shows a compaction indicator; the outcome vocabulary is explicit:
  `started`, `already-compacting`, `nothing-to-compact`, `run-finished`
  (client-side, for a torn-down run) and a failed compaction's error.
  Token before/after is shown when measurable.
- **Automatic thresholds.** A concrete default `CompactionPolicy` for workflow
  runs (see "Recommended defaults" below), resolved from the canonical layered
  configuration under `[agents.compaction]`, applied to newly started runs and —
  because `HarnessSettings` are "read at every resolution and never copied" and
  pi-durable re-resolves `options.settings` on every resolution — to running
  conversations as well, through a live getter rather than a snapshot taken at
  `DurableHost.open()`.
- **Per-window resolution.** Each threshold accepts an absolute token count or a
  percentage of the model's context window (`"15%"`), resolved against a
  reference window the host derives from the models its tracked runs actually
  use, falling back to the absolute default when no window is known.
- **Settings surface.** A new `Compaction` section in Home → Settings with
  `enabled`, reserve, background and keep-recent rows, effective values, the
  defaults shown, validation, and a bounded numeric editor (Settings has no
  numeric editor today). Values persist through the existing canonical
  `[agents]` layered-configuration write path (server-owned mutation +
  revision check).
- **Observability.** The durable runtime telemetry emits a compaction envelope
  (reason, blocking, attempt, duration, tokens before/after when measurable,
  errors), and the Agents panel / session status shows a compaction indicator
  with its reason.

## Recommended defaults (for developer review)

| Setting | Recommended default | Why |
| --- | --- | --- |
| `enabled` | `true` (every role, including the orchestrator) | `enabled` gates threshold and overflow compaction, not manual compaction. With it off, a run that outgrows its window fails with a provider error and the round's work is lost; compaction is the only path that keeps the run alive. |
| `reserveTokens` | `32000` (absolute) | The blocking threshold is `contextWindow - reserveTokens`, so an absolute reserve is already window-relative. `16384` (pi-durable's default) leaves too little room: one harness-bounded tool result is ~12–15k tokens (2000 lines/50 KB) and a verifier answer plus the next request is larger still. 32k covers about two big tool results. |
| `backgroundTokens` | `32000` (absolute; pi-durable's own default) | The gap between the background start and the blocking threshold must exceed one turn's growth so the background summary lands before blocking. 32k ≈ two large turns; it costs at most one summarizer call per crossing, and pi-durable starts a background compaction only while none is listed. |
| `keepRecentTokens` | `20000` (absolute), or `"15%"` with a 20 000 floor | This is the one value whose meaning drifts with the window (16% of 128k, 2% of 1M), so it is the one value offered as a percentage. Absolute 20 000 keeps a workable verbatim tail for the 128k–200k windows in normal use; `"15%"` is the recommended form for an operator who runs 1M-window models. |

Alternatives evaluated: **all-percentage** (rejected for reserve/background —
those are naturally absolute and are already applied against the actual window;
a percentage also multiplies the summarizer's own output budget, which is
`0.8 × reserveTokens`), **absolute-only** (rejected — `keepRecentTokens` becomes
negligible on a 1M window), and **per-run percentage** (not expressible: one
host serves every run of a workflow and pi-durable resolves one harness-wide
policy, so the plan resolves percentages against the smallest window among the
models the host's runs use, which is safe for the reserve and conservative for
`keepRecentTokens`). Per-preset / per-role overrides are out of scope (they
would need a per-conversation policy that pi-durable does not offer) and are
recorded as a follow-up in `design.md`.

## Capabilities

### New Capabilities

- `durable-agent-compaction`: the compaction policy contract (defaults, absolute
  and percentage forms, reference-window resolution, validation bounds, live
  application), the manual compaction lifecycle and its outcome vocabulary, the
  compaction feedback/observability contract, and the compaction indicator.

### Modified Capabilities

- `durable-agent-host`: the private control protocol gains the `compactRun`
  request and its structured outcomes; the host refuses compaction for an
  unknown/finished run and while a compaction is already listed.
- `durable-agent-configuration`: the compaction thresholds come from the
  canonical layered configuration (`[agents.compaction]`), with
  `agentHost.compaction` as an explicit hand-written override, and are read live
  at every resolution instead of being fixed at host open.
- `centralized-application-settings`: a `Compaction` Settings section with the
  four settings, effective values, validation and a bounded numeric editor,
  saved through the server-owned `[agents]` write path.
- `dashboard-agent-session-view`: the `/compact` command in the prompt's
  autocomplete and help, the transcript/status feedback it produces, and the
  refusal notices for a finished or already-compacting run.
- `durable-agent-tools`: the payload of the durable runtime compaction telemetry
  envelope (reason, blocking, attempt, duration, tokens before/after when
  measurable, error class).

## Impact

- `src/agent-host/`: `protocol.ts` + `client.ts` (`compactRun`),
  `host.ts` (`compactRun`, live compaction settings getter, reference-window
  resolution), `settings.ts` + a new pure compaction-policy module,
  `host-main.ts` (resolve `[agents.compaction]` from the layered config),
  `telemetry.ts` (`compaction_start`/`compaction_end` envelopes).
- `src/tui/dash/`: `ui/AgentSessionView.tsx` (`COMPACT_COMMAND`),
  `App.tsx` (host call + notices), `agent-session.ts` (compaction blocks and
  metadata), `agent-activity.ts` (reason-labelled indicator);
  `src/tui/orchestrator/OrchestratorView.tsx` (same command through its host).
- `src/tui/settings/`: `catalog.ts` (inventory entry), `items.ts` (section
  items), `state.ts`/`SettingsSectionView.tsx` (numeric editor), plus
  `src/tui/shared/routes.ts` (new section page) and
  `src/server/config.ts` (a `set-compaction` agents mutation).
- `src/workflow/`: layered-configuration read of `[agents.compaction]` and its
  validation (pure function reused by the server mutation and the host).
- Docs: `docs/settings-inventory.md`, `docs/config-inventory.md`, and the
  `agentHost` section of the settings documentation.
- No workflow-store or environment-state schema change. No dependency change;
  pi-durable stays pinned at its current version.
