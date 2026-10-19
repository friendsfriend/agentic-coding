# Proposal

## Why

The motivating defect of the env-setup rework is still live. After the
`grid-allocation-backend` env-setup promotion the developer pressed **Build** in
the Environments UI, and the UI built the **Docker** target — the live symlinked
`apps/build/<app>-build.Dockerfile`, which fails with a 401 from the Artifactory
inside `docker build` — instead of the drafted `build/shell` target the gate had
validated, built and started and reported as *"default build, supersedes the
Dockerfile target"*.

Code reading confirms three consumers with three rules:

- *"a drafted target supersedes the live target of the same action/profile"* is
  implemented **only for a staged view** (`supersededTargets` for the gate and
  the `configOverlay` branch of the agent resolver). After promotion there is no
  staged view and deletions are never published, so both live targets exist;
- the live resolution is a runtime-preference guess: `markDefaultTargets` groups
  candidates into families and marks everything ambiguous when two families are
  live, the agent resolver throws, and the Environments UI (`performAppAction`)
  simply runs whichever rendering its picker lists first — id order puts
  `/action/build/docker/default` before `/action/build/shell/default`;
- the post-promotion smoke check never resolved the **live** default build at
  all: it started "the default target" the server guessed and reported
  `build: skipped (proven identical by the gate)`, so the promotion passed while
  the developer's own build ran something else.

## What Changes

- **One resolver for the default target**, used by every consumer: the agent
  `env_build`/`env_test` tools, `env_list`, the developer's UI/TUI build, test
  and run action (through the marking the actions route puts on the definitions
  it returns), the validation gate and the post-promotion smoke check.
- **An explicit, developer-visible declaration**: `<config>/apps/defaults/<app>.json`
  names the default of an action (target id, discovered target id, runtime,
  runtime family or label). It is the only durable statement that survives a
  promotion, it is drafted/validated/promoted/rolled back like any definition
  file, and the approval diff renders the decision it is
  (`# default build for <app> = "<target>" (was ambiguous: docker, shell)`).
- **A choice between runtime families is never a silent guess.** The renderings
  of one family are not a choice; with nothing declared, a `build`/`test` is
  ambiguous — the agent tools and the gate fail with the candidate list and the
  file to declare the default in, and the UI refuses instead of preselecting a
  picker entry — while a `run` keeps the platform's documented order (Docker,
  then a script, then Kubernetes) and reports that reason.
- **The gate closes the loop**: it resolves the defaults from the staged root
  (declaration first), refuses a declaration that names no target or that a
  drafted target supersedes, and builds/starts/tests exactly the targets it
  resolved (previously an ambiguous pair skipped the build entirely).
- **The smoke check proves parity**: the gate's resolved defaults are recorded in
  the run's snapshot, and the smoke check resolves the live configuration through
  the same rule and fails with the rollback offer when they differ, naming the
  target it did not rebuild when they match.
- **The build-context preparation stops hiding failures**: it only exists for a
  build context that actually uses the configuration's `templates/` directory,
  copies into the build context deliberately (and removes exactly what it
  copied), and reports a failure instead of `2>/dev/null; true`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `bun-environment-action-engine`: the default target per app and action is
  resolved by one documented rule; a per-app declaration decides it; a
  build/test of several runtime families with nothing declared is a refusal, not
  a pick; the build-context preparation is bounded to a build context that uses
  the templates and never swallows a failure.
- `agent-environment-tools`: `env_list` reports which target is the default and
  why (declared / only candidate / preference) or the ambiguity, and a
  non-interactive consumer fails with the candidate list.
- `environment-setup-workflow`: the gate validates the declaration and runs the
  defaults it resolved; the approval diff shows the decision; the post-promotion
  smoke check compares the live defaults with the validated ones and fails the
  promotion when they differ.

## Impact

- `agentic-coding/src/server/actions/default-target.ts` (new) — the resolver,
  the declaration reader, the live resolution and the parity comparison.
- `agentic-coding/src/server/actions/routes.ts` — the agent resolver and the
  `default` marking on `GET /api/apps/{ident}/actions`.
- `agentic-coding/src/server/environment/{agent-routes,setup-validate,setup-drafts}.ts`
  — `env_list`, the gate and the drafted-path prefix plus the diff notice.
- `agentic-coding/src/workflow/{effect-runner,steps/env-setup,schema}.ts`,
  `src/workflow/runtime/reducers/effect-result.ts`, `src/contracts/workflow.ts`
  — the validated defaults in the snapshot and the smoke check's parity failure.
- `agentic-coding/packages/devenv/{types,cli}` and `packages/ui` — the
  `default` marking, the UI's selection rule and the picker's `[default]` badge
  and reason.
- `agentic-coding/agent-definitions/instructions/env-setup.md` — the author
  instruction to declare the default.
- Docs: `docs/agent-environments.md`, `docs/config-inventory.md`.
- No store schema change (`STORE_SCHEMA_VERSION` stays 6); the new snapshot
  metadata field is additive and optional.
