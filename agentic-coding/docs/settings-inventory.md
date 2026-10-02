# Settings inventory and policy (centralize-application-settings)

Home → Settings is the one destination for every supported application setting.
This file is the human-readable mirror of
`agentic-coding/src/tui/settings/catalog.ts`; the code table is authoritative
and `test/settings-configuration.test.ts` asserts that every entry resolves to a
Settings section page, a scope, a storage description, and at least one rendered
item, so nothing can be inventoried and then never shown.

Sections: `settings` (landing) with `settings.appearance`,
`settings.agents` and `settings.providers`. A section route may carry a
configured application/library id (`resourceId`) as its stable project scope.

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
| Routing and definition defaults | Agent Presets | `src/workflow/profiles.ts` | user | `[agents]` `default_profile`, `routes`, `role_routes`, `definition_defaults`, `gates` (the global stage-gate fallback a preset with no entry resolves against), `file_judgment` (the per-file judgment sweep: `enabled`, and the optional `threshold`, `unsure`, `concurrency` bounds) | no | next workflow start | no (no bounded editor; edit the config file) |
| Git providers | Providers/credentials | server integration families (`/api/providers`) | server | `$AGENTIC_CODING_CONFIG_DIR/providers` served by the connected server | yes | immediate | yes (edited in Environments) |
| Provider credentials | Providers/credentials | `src/workflow/credentials.ts`, `src/server/credentials.ts` | server | protected credential store; single-owner ephemeral prompts | yes | immediate | no (status only) |

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
- **Providers and environments** are owned by the connected server. Settings
  reads provider status through the capability-bearing environment client
  (`Authorization: Bearer <instance token>`) and opens the existing environment
  editors for changes; it never writes the client's own checkout.
- **Application of changes**: persistent agent edits affect subsequent workflow
  starts only. A running workflow keeps the routing resolved into its run input
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
`src/agent-host/credentials.ts`'s `PiAuthCredentialStore`, never copied.

## Credentials

Credential values are never read into Settings state: provider rows show
presence (`has_token`) and identity only, hosted credentials stay in the
protected store, and prompts remain single-owner and ephemeral. Secrets never
enter route payloads, navigation state, UI preference files, logs or telemetry.
