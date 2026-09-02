# Agentic Coding

`agentic-coding` combines transactional workflow engine and OpenTUI dashboard. Herdr hosts workspaces and managed agent processes; engine alone owns workflow state.

## Install

Requires Bun, Git, Herdr, and at least one configured agent runtime:

- Pi: `pi`
- stable OpenCode: `opencode`
- official OpenCode V2 beta: `opencode2`

Installer never installs agent runtimes, providers, or credentials. Configure Git credential helper or SSH agent before workflow start; dashboard never collects or persists passphrases.

```bash
./scripts/install.sh
```

Configuration installs at `~/.config/agentic-coding/config.toml`. The shipped [`pi/herdr-workflow.toml`](pi/herdr-workflow.toml) is a portable defaults template and provides only the model-agnostic `use-default-model` preset. Custom profiles, routes, and presets belong in the user configuration at that location (or in an explicitly supplied project configuration).

For an existing installation, migrate the current configuration before updating this checkout or running the installer. If the user config is still the repository symlink, materialize it as a regular file so its current profiles and presets remain user-owned:

```bash
config="$HOME/.config/agentic-coding/config.toml"
tmp="$config.migration.tmp"
if [[ -L "$config" ]]; then
  cp -L "$config" "$tmp" && mv "$tmp" "$config"
fi
test -f "$config" && test ! -L "$config"
```

After this one-time migration, update the checkout and run `./scripts/install.sh`. Installation copies the defaults only when the user config is missing and never overwrites an existing file or symlink.

> New engine migrates recognized legacy workflows on first access. Legacy rows/files remain preserved, but old engine must not resume workflow after new revisions/effects exist. Restore recorded pre-migration repository/worktree backup before binary rollback.

## Surfaces

```text
agentic-coding workflow  transactional engine
agentic-coding dash      workflow dashboard and observations
agentic-coding home      workflow list and observations
agentic-coding manager   alias for home
```

### Workflow CLI

```text
start --repo PATH --workflow-id ID --mode worktree|checkout
      [--workflow openspec-full|openspec-propose|openspec-apply|no-openspec|openspec-fusion-full|openspec-fusion-propose|wiki|research]
      [--fusion-profiles NAME,NAME,...] [--task TEXT] [--ticket ID]
status --repo PATH --workflow-id ID
action ACTION_ID --repo PATH --workflow-id ID --revision N [--input JSON_OR_PATH]
handoff --outcome complete|blocked|failed [--artifact PATH] [--message TEXT]
repair --repo PATH --workflow-id ID --revision N --step STEP --reason TEXT --confirm
projects
config
agent-extension list|install SOURCE|install-local PATH [--profile NAME]
```

`status` returns validated workflow view: revision, exact definition pin, current registered step, active runs, runtime/profile routing, effects, health, and available action IDs. Dashboard submits only returned action ID plus displayed revision.

Legacy role/phase verbs are removed. No compatibility shim translates `apply`, `verify`, `phase`, `override-phase`, verifier result, archive, or role-message commands.

## Workflow definitions

Built-ins register through public registry seam and pin exact `{id, version, digest}`:

- `openspec-full`: plan → approval → implementation → triage → verification/fix → developer review → archive → wiki approval → delivery → completed
- `openspec-apply`: validates pre-authored OpenSpec artifacts, then starts implementation; archive still precedes delivery
- `no-openspec`: requires non-empty task; excludes planning, OpenSpec verifier/checklist, and archive
- `openspec-propose`: plans and validates an OpenSpec change, waits for plan approval, then holds in completed until explicitly closed; it never implements or creates a PR
- `openspec-fusion-propose`: runs fusion planning and validation, waits for plan approval, then holds in completed until explicitly closed; it never implements or creates a PR
- `wiki`: requires a repository as read-only evidence, writes drafts only to the centralized wiki, and progresses through documentation → wiki approval → completed until explicitly closed; it never modifies source files or runs implementation, verification, archive, delivery, or pull-request stages
- `research`: runs research, wiki, and wiki review phases

Proposal and wiki workflows require `--mode checkout`, stay on the current branch, and never create or switch a Git branch/worktree. Wiki accepts a dirty checkout as its source baseline and requires a non-empty documentation task, so it supports repository initialization, undocumented-feature documentation, and business-information updates without changing repository content. They may run alongside a full checkout workflow; each workflow keeps its own change ID and artifacts. Because Git branch selection is checkout-global, a concurrent full checkout workflow can switch the branch while proposal agents are active; proposal observations may therefore race with that switch.

Registry validates IDs, actors, contracts, outcomes, effects, reachability, terminal paths, declared bounded cycles, and adapter requirements. Extra registered steps never alter existing graph unless explicitly composed. External workflow plugin loading is deferred; `agent-extension` means Pi runtime extension only.

## State and recovery

Canonical authority is `<main-repository>/.herdr-workflow/herdr.db`, resolved through Git common directory from main checkout or linked worktree. Normalized instance, run, event, and outbox tables replace writable worktree mirrors.

Every command executes under `BEGIN IMMEDIATE`:

1. parse command
2. load and validate snapshot plus pinned definition
3. authorize revision, run generation/capability, or effect lease
4. apply pure registered reducer
5. validate result
6. atomically persist snapshot, event, runs, and outbox
7. drain durable effects

Agent capabilities are random, single-use, generation-bound, hashed at rest, and consumed only after exact path/size/schema/run artifact validation. External effects use stable idempotency keys, leases, bounded retry, and observe-before-retry handlers. Unsafe exhaustion enters `attention-required`.

Raw phase overwrite is removed. `repair` previews compatible targets and affected runs, requires current revision plus reason/confirmation, expires incompatible runs/effects, and leaves paused state. Separate returned `resume` action revalidates routing and entry guards.

## Agent routing

Named profiles select `pi`, `opencode`, or `opencode-v2`. A fresh installation has no model-specific profiles: the built-in `use-default-model` preset uses Pi (configurable to another supported harness) without passing a model, allowing the selected harness to choose its own default. Custom profiles and presets are optional.

For custom profiles, precedence is:

1. exact step/role route
2. step route
3. preset fallback
4. definition default
5. global default
6. `use-default-model`

Resolved non-secret route is pinned for workflow lifetime. Missing executable, unsupported tool policy, capability mismatch, or diversity violation fails before agent/pane creation. Runtime/model never falls back silently.

All adapters use Herdr lifecycle only: create topology, wait for foreground shell, call `herdr agent start`, retry once only for unavailable shell, confirm with `herdr agent get`, then send full assignment with `herdr agent prompt`.

## Assignments and telemetry

Workflow instructions are plain Markdown under `agent-definitions/instructions/`, outside runtime skill/plugin discovery. Adapter sends common protocol + pinned step instructions + complete run assignment as normal message. No `SKILL.md`, `--skill`, or `/skill:` workflow loading.

Agents report only generic run outcome:

```bash
agentic-coding workflow handoff --outcome complete --artifact "$HERDR_OUTPUT"
```

Engine derives workflow, role, generation, output schema, and successor from run environment and pinned definition.

### Agent configuration presets

Named presets bundle a full step/role → profile routing into the committable
agents config (`[agents.presets]` in `config.toml` or project
`.pi/herdr-workflow.toml`), so switching between agent/model strategies no
longer requires rewriting routes. `use-default-model` is always available as
an immutable built-in choice; only custom profiles and presets are persisted by
the dashboard:

```toml
[agents.presets.frontier-plan]
description = "Frontier planning, cheap workers"
default_profile = "pi-cheap"          # fallback for unrouted steps
[agents.presets.frontier-plan.steps]
"core.plan" = "pi-planner"
"core.implementation" = "oc-worker"
[agents.presets.frontier-plan.roles."core.verification"]
quality-verifier = "pi-review"
```

Select a preset per workflow start via the new-workflow modal's **Agent
preset** step or `agentic-coding workflow start --preset <name>`; selection is
per start and never rewrites global defaults. Resolution order: preset role →
preset step → preset default → existing chain. Profiles and presets can be
created, edited, and deleted from the home dashboard's model configuration
modal (`m`); edits are written back to the config file that supplied the
agents section. Because project-level `.pi/herdr-workflow.toml` is merged over
the user config, a committed agent configuration is trusted and executed as
code: profile `executable`, `model`, `tools`, and preset routes from a cloned
repository are honored by workflow starts. Only commit agent config you
control, and review `.pi/herdr-workflow.toml` when cloning untrusted
repositories. At startup every routed profile's model is validated against
its runtime's model enumeration (`pi --list-models`, `<exe> models`); an
unknown model fails startup before any agent launches.

Telemetry uses normalized engine/adapter/runtime envelope with W3C trace context. Runtime bridges under `agent-definitions/bridges/` are explicitly injected per managed run, best effort, and observational only. They never read workflow state, infer completion, nudge/retry agents, or switch runtime/model. Unsupported deep runtime fields remain absent; baseline adapter lifecycle stays available.

## Knowledge wiki

Agentic Coding keeps a centralized **Open Knowledge Format v0.2** bundle (see [the OKF specification](https://github.com/GoogleCloudPlatform/open-knowledge-format)) at `~/.config/agentic-coding/wiki`. Set `HERDR_WIKI_DIR` or `[wiki] root = "..."` to relocate it; the centralized bundle can contain knowledge from multiple projects and OKF does not require one repository per bundle. The root `index.md` declares `okf_version: "0.2"`; concept ids are relative Markdown paths beneath the root. Use `projects/<project-id>/<concept>` for facts specific to one project or repository, and `shared/<concept>` only for claims that apply across projects with evidence from every project covered. A repository-relative source path is meaningful in the context of the project named by its concept, not as a universal location or rule. `index.md` and `log.md` are reserved filenames, not concept documents. Concepts use YAML frontmatter with `type`, `title`, `description`, optional `tags`, provenance, trust, and lifecycle fields, followed by Markdown.

Use `agentic-coding workflow wiki list`, `search`, `show`, `write`, `verify`, and `log`. Search and read before writing, update an existing concept in place, and do not create active near-duplicates. Sequential planners and the consolidator can write drafts; archive verifies shipped knowledge. The wiki role may read repository evidence and write centralized wiki drafts only; it must not write source files. Reads expose status, trust tier, and staleness. Existing `repository/*` Agentic Coding drafts should move to the matching `projects/agentic-coding/*` identifier without verification; if a safe move is unavailable, retain the legacy record as explicitly deprecated and keep only the project-scoped replacement active. The wiki approval gate grants the human-reviewed tier only after developer approval; `[wiki] reviewer` configures the reviewer identity. OKF §3 recommends `git init` on the bundle for history. Changing pinned instructions or manifests may require `agentic-coding workflow repin` for in-flight workflows.

## Development

```bash
cd agentic-coding
bun install --frozen-lockfile
bun test
bun run type-check
bun run build
```

Focused workflow tests live in `agentic-coding/test/workflow-*.test.ts`. Worker runs only affected files.

Downstream verifier gates (not worker implementation commands):

```bash
cd agentic-coding && bun install --frozen-lockfile
cd agentic-coding && bun test
cd agentic-coding && bun run type-check
cd agentic-coding && bun run build
scripts/test-herdr-workflow.sh
openspec validate rework-workflow-state-handling --strict
HERDR_LIVE_RUNTIME_SMOKE=1 HERDR_LIVE_RUNTIME_EXECUTABLE=pi scripts/test-herdr-workflow.sh  # opt-in
```

Shell smoke uses fake Herdr by default and exercises new start/status/action/handoff/repair surface. Live smoke requires installed/configured Herdr and selected runtime.
