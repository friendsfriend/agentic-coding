# Settings inventory and policy (centralize-application-settings)

Home → Settings is the one destination for every supported application setting.
This file is the human-readable mirror of
`agentic-coding/src/tui/settings/catalog.ts`; the code table is authoritative
and `test/settings-configuration.test.ts` asserts that every entry resolves to a
Settings section page, a scope, a storage description, and at least one rendered
item, so nothing can be inventoried and then never shown.

Sections: `settings` (landing) with `settings.appearance`,
`settings.agents`, `settings.browser`, `settings.stages` and
`settings.providers`. A section route may carry a configured application/library
id (`resourceId`) as its stable project scope.

## Scopes

| Scope | Meaning |
| --- | --- |
| `client` | This client only: `$AGENTIC_CODING_CONFIG_DIR/tui.json` (default `~/.config/agentic-coding/tui.json`). |
| `user` | User-level configuration (no project selected). |
| `project` | Project-scoped configuration, selected by a configured application/library id. |
| `server` | Owned by the connected server process and its configuration directory. |

Settings never infers a project from the current working directory, and a
remote read/write never falls back to a local configuration file: an
unavailable or unauthorized server is a section error with a retry.

## Entries

| Setting | Section | Owner | Scope | Storage | Secret | Effect | Editable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Theme | Appearance | `src/tui/shared/preferences.ts` | client | `$AGENTIC_CODING_CONFIG_DIR/tui.json` · `theme` | no | immediate | yes (shared theme picker) |
| Agent profiles | Agent Presets | `src/server/config.ts` | user / project | `[agents.profiles]` in the layered workflow config | no | next workflow start | yes (inline form) |
| Agent presets | Agent Presets | `src/server/config.ts` | user / project | `[agents.presets]` in the layered workflow config — `pools`, `roles`, `steps`, and the stage gate `gates` table (`planApproval`, `verification`, `developerReview`, `wiki`; `always` or `auto`) | no | next workflow start | yes (inline form) |
| Classifier provider | Agent Presets | `src/server/config.ts` | user | `[agents.classifier]` in the layered workflow config — `provider` is `opencode-zen` (hosted, usage-based, requires `OPENCODE_API_KEY`) or `laya-local` (offline sidecar); the local model is installed only on explicit request | no | next workflow start | yes (Agent Presets picker) |
| Orchestrator session | Agent Presets | `src/server/config.ts` | user | `[agents.orchestrator]` `model` (`provider/modelId`), `thinking`, `monitor` (`wake`/`notify`/`off`) and the file-only event bounds `stall_minutes` (default 30), `reconcile_seconds` (default 30) and `event_burst_limit`/`event_burst_window_seconds` (default 120 events per 10 s) in the layered workflow config; absent `model`/`thinking` use the durable host defaults and an absent `monitor` means `wake` | no | next time the Orchestrator page opens, the next time the shell starts its workflow monitor, and the next server-side event derivation pass for the file-only bounds | yes (Agent Presets picker) |
| Routing and definition defaults | Agent Presets | `src/workflow/profiles.ts` | user | `[agents]` `default_profile`, `routes`, `role_routes`, `definition_defaults`, `gates` (the global stage-gate fallback a preset with no entry resolves against), `file_judgment` (the per-file judgment sweep: `enabled`, and the optional `threshold`, `unsure`, `concurrency` bounds) | no | next workflow start | no (no bounded editor; edit the config file) |
| Headless browser | Browser | `src/server/browser/install.ts` | server | `$AGENTIC_CODING_CONFIG_DIR/browsers` (Playwright's `PLAYWRIGHT_BROWSERS_PATH`); a detected system Chrome is used instead when present, and the opt-in Install row is the only download path in the application. The row also reports the *headed* capability a `stage_login` hand-off needs (a system Chrome or a full Chromium build, plus a display on Linux); a shell-only install can run the headless tools but cannot show a login window | no | immediate | yes (Settings → Browser → Install Chromium) |
| Browser sessions | Browser | `src/workflow/effects.ts` | user | `browser.max_sessions`, `browser.idle_ttl_minutes` and `browser.viewport` in the layered workflow config | no | immediate | no (file-only bounds, shown read-only) |
| Telemetry receiver binds | — | `src/workflow/effects.ts` | user | `telemetry.receiver.container_bind` in the layered workflow config: `auto` (the container bridge gateway, on a Linux engine), `off` (loopback only) or one explicit address; a wildcard address is never bound | no | next start | no (file-only; read when the receivers bind) |
| Compaction | Compaction | `src/workflow/compaction.ts` (write through `src/server/config.ts`) | user | `[agents.compaction]` in the layered workflow config — `enabled`, `reserveTokens`, `backgroundTokens`, `keepRecentTokens` and `ceilingTokens`; the window-relative fields accept a whole token count or a percentage of the model's context window (`"15%"`), while the cost ceiling is absolute tokens (`0` turns it off); a present `agentHost.compaction` overrides the section, and a project overlay's `[agents]` is not read at all | no | immediate (the durable host re-reads the policy at every generation) | yes (bounded numeric editor / on-off row) |
| Run-progress checkpoint | Compaction | `src/workflow/checkpoint.ts` | user | `[agents.checkpoint]` in the layered workflow config — `enabled`, `steer`, `contextTokens` and one `softTurns`/`hardTurns` table per checkpoint class (`worker`, `planner`, `verifier`, `mechanical`, `other`); absent keys use the measured per-class defaults, and `hardTurns` is resolved to at least twice `softTurns` | no | next run start (the durable host re-reads the section at every run start) | no (file-only; edit the config file) |
| Git providers | Providers/credentials | server integration families (`/api/providers`) | server | `$AGENTIC_CODING_CONFIG_DIR/providers` served by the connected server | yes | immediate | yes (edited in Environments) |
| Provider credentials | Providers/credentials | `src/workflow/credentials.ts`, `src/server/credentials.ts` | server | protected credential store; single-owner ephemeral prompts | yes | immediate | no (status only) |
| Hosted stages | Stages | `src/server/stages/catalog.ts` | server | `$AGENTIC_CODING_CONFIG_DIR/stages/definitions/*.json` and `stages/policy.json`, read from the canonical configuration root only (a repository overlay is ignored). The policy's `interactiveLogin` (`"local"`, the default, or `"never"`) decides whether a login the server cannot automate opens a headed window — a stage may narrow `local` to `never` with a diagnostic and can never widen `never` — and `limits.maxLoginHandoffSeconds` (default 900 s, hard ceiling 1800 s, only clamped down further by `ceilings.maxLoginHandoffSeconds`) bounds one hand-off, queue time included. Under the default, a role whose credential variables are unset now opens a window instead of answering `credential-missing` | no | immediate (every read re-reads the files; a durable run sees the same catalog through `stage_info`) | no (structure is read-only: a stage file is edited on disk) |
| Stage credentials | Stages | `src/server/stages/routes.ts` | server | `$AGENTIC_CODING_CONFIG_DIR/.env` — only the variables the stage catalog references | yes | immediate (the next login reads the new value; a running session keeps the credentials it installed) | yes (masked entry; only a referenced variable can be written) |

## Source and restart policy

- **Appearance** is client-local. Saving writes `tui.json` through
  `writeSettingsAtomically` (temp file + rename), preserving unrelated keys; a
  failed write reports the failure and leaves the previous file intact.
- **Agent settings** resolve through the layered workflow config and are
  written through the authenticated server (`POST /api/v1/config/agents`). The
  client names the revision it read (`expectedRevision`); the server digests the
  effective `[agents]` section and refuses a write when another client changed
  it since, so a concurrent edit is detected instead of overwritten. Unrelated
  keys, unknown preset role tables and source precedence are preserved.
- **Compaction** is user scope: a save is pinned to the user-level configuration
  file (`saveAgentsSection(..., { userScope: true })`), so a project overlay's
  `[agents]` section can neither capture the write nor change the effective
  policy, and the durable host — which resolves the same user-level document —
  reads exactly what the section shows. Its rows are edited one value at a time
  with the bounded numeric editor (`src/tui/settings/NumberEditor.tsx`): digits
  plus one trailing `%`, per-field bounds, an inline message when an entry is
  refused, Enter to save and Escape to cancel. The percentage form is resolved
  per run by the host against the smallest context window among the models its
  tracked runs use (an absolute default applies when no window is known), which
  is why the section states that rule and the effective fallback rather than a
  single window.
- **Providers and environments** are owned by the connected server. Settings
  reads provider status through the capability-bearing environment client
  (`Authorization: Bearer <instance token>`) and opens the existing environment
  editors for changes; it never writes the client's own checkout.
- **Stages** is a read of the server's stage catalog (`GET /api/v1/stages`, and
  the agent-facing twin under the environment capability) plus one write
  (`POST /api/v1/stages/credential`), which the server resolves against the
  catalog: a variable no allow-listed stage references is refused
  (`credential-unknown`), so the section can never become a general `.env`
  writer. The section shows the validation state, the access level, the apps and
  each role's credential *presence*, and lists a refused file with its
  value-free diagnostics; the credential row is offered only for a variable the
  catalog references, is typed masked, and its value is never returned by a read,
  stored in the snapshot, or shown again. A transport-less shell reads the same
  catalog through `src/server/stages/operations.ts`, so a local run and a
  connected one show one catalog.
- **Application of changes**: persistent agent edits affect subsequent workflow
  starts only. Orchestrator starts are not capped: the server counts nothing and
  refuses no start, whatever the workload. A running workflow keeps the routing resolved into its run input
  (its pins/revisions) until its existing explicit revision-bound adoption
  operation is used. Editing server configuration never restarts a server.
- **The per-file judgment sweep** (`[agents]` `file_judgment`) is disabled unless
  `enabled` is true. Its provider and model are not settings of their own: they
  resolve from `[agents.classifier]` and `agents.profiles["jev-classifier"].model`
  like every other classifier integration, so an operator keeps one model knob.
  Unset bounds use `threshold` 0.7 and `unsure` 0.25; the local provider is
  always asked for its own model id, so selecting it is what makes the sweep run
  offline. An enabled sweep spends one classifier call per changed file on every
  verification round and writes its rendered section to a `file-signals`
  artifact under the config root — outside the worktree, so the sweep's own
  output cannot enter the next round's changed-file set — and records it as
  evidence the verifiers are told to read. Every judgment is content-addressed:
  the key is the provider, the model, the question, and the exact state bytes, so
  a file that has not changed since an earlier round is answered from
  `$CONFIG_ROOT/classifier-cache` instead of being asked again. The candidate set
  is cumulative from the base commit, so that is the common case rather than an
  edge one. A changed file, a changed question, or a changed model is a different
  key rather than a policy that has to be invalidated, and a fully cached round
  needs no classifier transport and starts no sidecar. `AGENTIC_CLASSIFIER_CACHE=off`
  bypasses the cache for an operator who needs to see the calls happen.
- **The in-session `ask_jev` tool** is not gated by `file_judgment.enabled`: it is
  a general tool the agent drives, and the sweep is one engine-authored use of the
  same classifier. Every managed pi run loads the extension and names the tool in
  the launch allowlist, so an agent never lacks a tool the pinned protocol names;
  the *binding* is what decides whether it can answer, and it is offered whenever
  the resolved provider is one a pane can reach without a credential — currently
  the local sidecar. The binding carries only the transport (`provider`, `model`,
  `endpoint`) in the pane environment, never a question, a threshold, or a
  conventions preamble: the agent writes the questions, and a file-judgment
  preamble would bias a question about anything else. A hosted provider builds no
  binding, so the tool reports in-session judgment as unavailable rather than
  handing an agent a credential its own shell can read. The local sidecar is a
  standalone local service: the UI starts it when `laya-local` is selected and
  it keeps running after the UI exits, and a launch whose selection is
  `laya-local` starts it too (one shared attempt per wave of launches) before
  the binding is built. It binds a fixed loopback port (`LAYA_PORT`, default
  4571) and a start adopts a sidecar already answering there, so a pane's
  recorded endpoint survives an engine restart, nothing waits for a still-loading
  model, and a second engine never doubles it. Nothing stops it — not a provider
  switch, not server shutdown. The tool keeps the last four
  assembled states per session, so a follow-up round about the same situation
  reuses one by handle: the files are re-checked (mtime and size) and only changed
  ones are re-read, while a command's output is reused as it was and reported as
  such. Nothing about a reuse is silent. A handle is generated, never a session
  counter: a counter is predictable, and a stale handle — a pane is replaced every
  round and compaction keeps old handles in context — would then resolve to a
  different state assembled under the same name.

## Managed pi tool parity

A managed pi session inherits the tools the user enabled globally in their own
**user-level** pi settings (`defaultTools`), because pi's `--tools` is a strict
allowlist that *replaces* that selection. pi also merges a project-level
`<cwd>/.pi/settings.json`, but a managed session launches with `--no-approve`, so
pi itself ignores project-local files for that run and reading them here would
hand an agent a tool its session would not otherwise load. The two mechanisms
have to agree for a tool like `codemode` to appear: its name goes into the
allowlist, and its built-in extension is requested with an explicit
`-e builtin:<name>`, since managed sessions pass `--no-extensions` to keep the
user's extension files out of a run. Only tools a built-in extension provides are
inherited (currently `codemode` and `tool_search`): a tool from a user's own
extension file would be a promise the launch cannot keep. A profile that declares
no tool list keeps pi's own default selection, so nothing about an undeclared
profile changes. The allowlist governs what the model may call, but a `codemode`
script it writes may reach every active `direct` tool plus every registered
`codemode`/`deferred`-exposure tool, so a read-only step stays read-only because
`edit`/`write` are `direct` and never named — not because the list contains only
`read` and `bash`.

`ask_jev` and the question tools are pi-only: `opencode` and `opencode-v2` runs
have no equivalent extension, so a route that resolves to one of them starts
without them (a pre-existing gap, not a regression). `pi-durable` carries its
own native equivalents (`src/agent-host/tools.ts`), not this pi-extension
mechanism.

## `agentHost` (durable agent host settings)

`pi-durable` runs read their default provider/model/thinking level,
compaction, retry, and steering/follow-up mode from an `agentHost` section of
the application configuration, resolved by `src/agent-host/settings.ts` and
seeded once by `src/agent-host/host-main.ts`. The section is absent by
default; the first `pi-durable` use seeds it from the matching keys of the
global pi `settings.json` (`defaultProvider`, `defaultModel`,
`defaultThinkingLevel`) and persists the seeded value into the configuration
file, after which it is never overwritten by a later change to the global
default — the same "seed once, then owned" pattern `config-root.ts` uses for
the configuration root itself. No credential value is ever part of this
section: provider auth is read live from `~/.pi/agent/auth.json` through
`src/agent-host/credentials.ts`'s `PiAuthCredentialStore`, never copied. The
section's `compaction` table is the hand-written escape hatch for the policy
below: when it is present it wins over `[agents.compaction]`.

## Compaction (`[agents.compaction]`)

Durable (`pi-durable`) runs summarize their own conversation context. The policy
is the section below, resolved by the pure `src/workflow/compaction.ts` and read
by the durable host at every resolution — a save reaches a run already in
flight, without a host restart.

```json
{ "agents": { "compaction": {
  "enabled": true,
  "reserveTokens": 32000,
  "backgroundTokens": 32000,
  "keepRecentTokens": 20000,
  "ceilingTokens": 150000
} } }
```

| Value | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Gates threshold, overflow and ceiling compaction only; `/compact` in a session works either way |
| `reserveTokens` | `max(32000, 30% of the run's window)` | Room kept free for the answer: a request above `contextWindow - reserve` waits for a summary — 70% of the model's window with the default. It also bounds the summarizer's own output budget (`0.8 × reserve`) |
| `backgroundTokens` | `32000` | How far below the blocking threshold a summary starts in the background; `0` disables the background path |
| `keepRecentTokens` | `20000` | Recent context a summary keeps word for word; it must stay below `ceilingTokens`, and is resolved to at most half an active ceiling |
| `ceilingTokens` | `150000` | **Cost ceiling** (absolute): once a request has carried this many tokens, the run compacts at its next safe point. `0` turns it off; automatic compaction off turns it off too |

Each window-relative token value (`reserveTokens`, `backgroundTokens`,
`keepRecentTokens`) is either a whole number of tokens or a percentage of the
model's context window (`"15%"`). An absolute value is used as written, and a
percentage is resolved against the smallest context window among the models the
host's tracked runs use, falling back to that field's absolute default when no
window is known. The cost ceiling is absolute only: a percentage of a 1M window
would silently become a different control on a 128k model, and the ceiling exists
to bound absolute spend.

The reserve's default is the one that is *not* absolute, because it is the value
that decides when automatic compaction fires: every model the presets run
declares a 1M-token window (`opencode-go`'s `deepseek-v4.1-flash` and
`gpt-6-luna`, `kimi-coding`'s `k3`), where a fixed 32 000-token reserve put the
blocking threshold at 968 000 tokens and the background threshold at 936 000 —
context a run never reaches, so it never compacted. The default is therefore
`max(32000, 30% of the window)`: automatic compaction starts at 70% of the
model's window, and the absolute 32 000 remains the no-window fallback and the
floor for a small window. `backgroundTokens` stays absolute (one large turn's
lead below the blocking threshold), and `keepRecentTokens` is left to the
operator's percentage form when the verbatim tail should scale: a fixed 20 000
is 16% of a 128k window but 2% of a 1M one.

Resolution floors and clamps a bad configuration instead of letting it defeat
itself: `reserveTokens` and `keepRecentTokens` are at least 4096,
`backgroundTokens` at least 0, the reserve is at most half a known window, and
the kept-verbatim tail at most `window - reserve - 1024`. Values are validated
when they are written (a non-integer, a negative count, an out-of-range
percentage, a ceiling that is neither `0` nor at least 16384, a percentage where
the ceiling is absolute, and a kept tail at or above the ceiling), and a
hand-edited file that fails validation falls back to the documented default for
that field rather than failing a durable launch.

The reserve is an *overflow* guard: it decides when a request can no longer fit
the window. The ceiling is the *cost* control, and the two are deliberately
separate. Every turn of a long run re-reads the whole context, so the second half
of a run costs 1.87–2.9× the first; on a 1M-token window the overflow guard sits
at 700,000 tokens, which a measured worker run (911,257 tokens) barely reached
and the orchestrator (333,278) never did. The ceiling therefore applies **only
when it is below the overflow threshold**: on a smaller window the overflow guard
is the tighter of the two, and a ceiling above it is ignored once with a
`runtime.compaction_ceiling` warning rather than compacting twice in a row. Two
guards keep the ceiling itself from looping: a compaction may not follow another
until 20 turns or 40,000 tokens of new context have passed (the reduced context
is measured after the summary, so the floor counts real growth), and after three
ceiling compactions inside ten turns the ceiling stops for that conversation and
records a `loop-guard` warning. A ceiling compaction is admitted at the measured
end of a turn and placed by `pi-durable` at the next turn boundary, so it never
interrupts a tool call; it runs the same summarizer the overflow path runs, with
no instructions, so a worker's assignment and a verifier's finding references
survive it the same way.

Manual compaction is the `/compact [instructions]` command of an agent session
(`docs/orchestrator.md`); its outcome vocabulary is `started`,
`already-compacting` (naming the reason in flight) and `nothing-to-compact`, and
a run the host no longer tracks is reported as finished. Both paths emit the
`runtime.compaction_start` / `runtime.compaction` telemetry envelopes
(`docs/agent-session-telemetry.md`), each carrying the `kind` the analysis counts
(`auto-ceiling`, `auto-overflow` or `manual`); the ceiling's own decisions are
reported by `runtime.compaction_ceiling`, and `runtime.settled` carries the peak
context and the per-kind counts of the run.

## The run-progress checkpoint (`[agents.checkpoint]`)

A durable run's supervisor is `src/agent-host/progress-checkpoint.ts` with its
thresholds in the section below, resolved by the pure
`src/workflow/checkpoint.ts`. The durable host re-reads the section at every run
start, so a save reaches the next run without a host restart, and none of it can
stop a run on a turn count alone — see
[`workflow-architecture.md`](./workflow-architecture.md#the-run-progress-checkpoint-efficiency-backlog-item-19).

```json
{ "agents": { "checkpoint": {
  "enabled": true,
  "steer": true,
  "contextTokens": 200000,
  "worker": { "softTurns": 280, "hardTurns": 1400 }
} } }
```

| Value | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` evaluates no checkpoint at all: the whole rollback |
| `steer` | `true` | Whether a `steer` decision submits its catalog nudge; `false` turns every steer rule into `continue`, and a steered signal can then never escalate |
| `contextTokens` | `200000` | The measured-context threshold: at or above it the checkpoint may `compact` (through the cost ceiling's admission), never stop |
| `worker` / `planner` / `verifier` / `mechanical` / `other` | the measured table | One table per checkpoint class: `softTurns` (the first checkpoint, and the base of the interval) and `hardTurns` (the limit whose only decision is an escalation) |

A class table may set only one of the two values: the other comes from the
class's default, and the resolved hard limit is never below twice the resolved
soft threshold. The class comes from the step's registered behaviour
(`HERDR_CHECKPOINT_CLASS`); a step that declares none uses the `other` row, which
is the worker row. The shipped defaults are the measured ones for each class
(`worker` 280/1400, `planner` 60/300, `verifier` 70/350, `mechanical` 30/250);
`softTurns` must be at least 10.

Validation is strict where the section is loaded (a non-boolean `enabled`, a
non-positive `contextTokens`, a table that is not a table, or a soft/hard pair
that breaks the invariant is refused with the field that carries it) and lenient
where the host reads it live (a mistyped hot edit falls back to the documented
default for that key rather than failing a running conversation).

## Credentials

Credential values are never read into Settings state: provider rows show
presence (`has_token`) and identity only, hosted credentials stay in the
protected store, and prompts remain single-owner and ephemeral. Secrets never
enter route payloads, navigation state, UI preference files, logs or telemetry.
