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
  same classifier. It is offered whenever the resolved provider is one a pane can
  reach without a credential — currently the local sidecar — and carries only the
  transport (`provider`, `model`, `endpoint`) in the pane environment, never a
  question, a threshold, or a conventions preamble: the agent writes the questions,
  and a file-judgment preamble would bias a question about anything else. A hosted
  provider builds no binding, so the tool reports in-session judgment as
  unavailable rather than handing an agent a credential its own shell can read.
  The tool keeps the last four assembled states per session, so a follow-up round
  about the same situation reuses one by handle: the files are re-checked (mtime
  and size) and only changed ones are re-read, while a command's output is reused
  as it was and reported as such. Nothing about a reuse is silent. A handle is
  generated, never a session counter: a counter is predictable, and a stale handle
  — a pane is replaced every round and compaction keeps old handles in context —
  would then resolve to a different state assembled under the same name.

## Credentials

Credential values are never read into Settings state: provider rows show
presence (`has_token`) and identity only, hosted credentials stay in the
protected store, and prompts remain single-owner and ephemeral. Secrets never
enter route payloads, navigation state, UI preference files, logs or telemetry.
