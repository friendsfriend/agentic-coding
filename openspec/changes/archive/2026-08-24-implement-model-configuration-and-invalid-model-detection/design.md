## Context

Workflow runs route each step to a named agent profile via `agents` configuration
(`src/workflow/profiles.ts`): `profiles`, `routes`, `role_routes`,
`definition_defaults`, `default_profile`. Config loads from
`~/.config/agentic-coding/config.toml` (user) merged with per-repo
`.pi/herdr-workflow.toml` (project) in `loadConfig()` (`src/workflow/effects.ts`);
both are plain TOML, so anything in them is committable.

Today there is no notion of a *set* of step assignments that can be switched as
a unit: switching strategy means hand-editing `routes`/`role_routes`. The new
workflow modal (`src/tui/dash/ui/NewWorkflowModal.tsx`) offers no agent/model
choice, and the home dashboard (`src/tui/dash/Home.tsx`) offers no config
management beyond theme selection. Model typos surface only when the spawned
agent fails mid-run; start-time preflight (`preflightProfile`) checks
executable presence and capabilities but never the model string.

All three execution environments expose their available models via CLI:

- `pi --list-models [search]` — table with `provider` / `model` columns
- `opencode models [provider]` — lines of `provider/model`
- `opencode2 models` — same shape as opencode

Routing is pinned at workflow start (`resolveRouting` + digest in
`workflow-agent-assignment` / `agent-runtime-routing` specs), so a per-start
profile choice composes cleanly with existing pinning semantics.

## Goals / Non-Goals

**Goals:**
- Named **agent configuration presets**: one entry maps every workflow step
  (and verification roles) to an agent profile.
- Preset selection in the new workflow modal; the chosen preset pins routing
  for that workflow.
- Dashboard CRUD for agent profiles (execution env, model picked from the
  runtime's available models, agent name) and presets, persisted to config so
  it stays committable.
- Invalid-model detection at workflow start: routed profiles whose model is
  not offered by their execution environment fail preflight with an
  actionable error.

**Non-Goals:**
- Editing non-agent config (workflow, projects, telemetry, ui) from the
  dashboard.
- Live model availability polling during a running workflow (pinning means a
  started workflow keeps its routing).
- Changing adapter launch behavior or the workflow engine lifecycle.
- Supporting pi model *patterns/globs* in validation (exact ids only).
- Migrating legacy `models`/`thinking` top-level keys further.

## Decisions

### D1: Presets live inside the existing `agents` config section (additive)

```toml
[agents.presets.frontier-plan]
description = "Frontier planning, cheap workers"
default_profile = "pi-cheap"          # fallback for unrouted steps
[agents.presets.frontier-plan.steps]
"core.plan" = "pi-planner"
"core.implementation" = "oc-worker"
# ...one entry per agent step
[agents.presets.frontier-plan.roles."core.verification"]
quality-verifier = "pi-review"
```

Rationale: reuses the existing load/merge/pin pipeline and stays plain,
committable TOML. Alternative considered — a separate presets file — was
rejected because it would split routing truth across two files and break the
single `agents` merge point.

Validation rules (extend `parseAgentsConfig`):
- Every preset entry references an existing profile name.
- A preset defines at most one entry per step and per (step, role).
- Coverage is checked at workflow start against the definition's agent steps:
  a selected preset lacking a step (and without a usable fallback) fails
  startup with the missing step named.

### D2: Resolution order gains an optional per-start preset override

`profileFor` resolution becomes:
1. selected preset (`steps[stepId]`, then preset `roles[stepId][role]`,
   then preset `default_profile`),
2. existing chain (`role_routes` → `routes` → `definition_defaults` →
   definition default → `default_profile`).

The preset override is passed per start call (modal selection) and never
written back into global config — starting a workflow remains side-effect
free. Routing pinning is unchanged: the resolved routes are pinned with
digests as today.

### D3: Invalid model detection in `preflightProfile`

New helper (e.g. `assertModelAvailable(profile)`) runs inside
`preflightProfile`, which both start paths (`engine.ts` in-process start and
`workflow/cli.ts` CLI start) already invoke for every routed profile:

- Enumerate the runtime's models via its CLI (`pi --list-models`,
  `<exe> models`), parsed to a `Set<string>` of `provider/id`.
- If `profile.model` is set and not in the set → throw
  `profile <name>: unknown model <model> for runtime <runtime>` including up
  to N available models in the message.
- pi `:<thinking>` suffixes are stripped before comparison; thinking validity
  itself is left to the runtime.
- Results are cached per (executable, short TTL) within a process to keep
  multi-route starts cheap.
- If the enumeration command fails, preflight fails closed with the command
  error — an environment that cannot prove model availability does not start
  workflows silently.

Alternative considered — validating only in the dashboard — rejected because
hand-edited committed config must be caught too; start-time is the single
choke point both entry paths share.

### D4: Dashboard management modal + config write-back

One new modal component (e.g. `ModelConfigModal.tsx` under
`src/tui/dash/ui/`, opened from Home via a key binding and help entry):

- Two lists: **Profiles** and **Presets**.
- Profile editor: name, execution env (`pi` | `opencode` | `opencode-v2`),
  model (selectable list from D3's enumeration for the chosen env), optional
  agent name (only offered for opencode/opencode-v2), optional thinking level
  (pi).
- Preset editor: for each agent step of the standard definitions plus
  verification roles, pick a profile; plus optional preset default.
- Create/edit/delete for both; delete refuses to remove a profile still
  referenced by a preset, route, or default.

Write-back target: the config file that supplied the `agents` section being
edited (highest-priority existing candidate among `HERDR_WORKFLOW_CONFIG`,
user config, project `.pi/herdr-workflow.toml`); if none defines `agents`,
the user config file is created. The whole file is rewritten with
`Bun.TOML.stringify` after a read-modify-write cycle.

### D5: Modal integration

`NewWorkflowModal` gains an "Agent preset" list step between workflow type
and ticket, fed by presets from the loaded config plus a "(config defaults)"
entry meaning current behavior. The selection travels through
`startArgs`/`startWorkflowInProcess` as an optional field and reaches
`resolveRouting` as the D2 override. CLI parity: `agentic-coding workflow
new` accepts an optional `--preset <name>` flag.

## Risks / Trade-offs

- [TOML rewrite drops comments] Whole-file `TOML.stringify` erases hand
  comments in managed config files. → Accepted for v1: once the dashboard
  manages these files they are machine-edited; documented in the modal help.
  Risk contained because `HERDR_WORKFLOW_CONFIG` and project files are
  opt-in.
- [Runtime model enumeration cost/availability] CLI calls add latency and can
  fail (offline, catalog missing). → Cached per process; fail-closed keeps
  semantics predictable; failure message names the command to run.
- [Preset/definition drift] Definitions gain steps over time; stored presets
  may miss them. → Coverage validated at start (D1) with actionable error;
  fallback resolution keeps old presets usable when a preset default or
  global default exists.
- [Concurrent dashboard edits vs running workflows] None: started workflows
  keep pinned routing; edits only affect future starts.

## Migration Plan

Purely additive config schema; existing configs parse unchanged (no presets =
current behavior). No data migration. Rollback = remove the new section /
stop using the modal entries; validation additions are strict only about
values users newly enter.

## Open Questions

None blocking; model-enumeration parsing is verified against the three CLIs'
current output formats during implementation (task list covers a parser test
per runtime).
