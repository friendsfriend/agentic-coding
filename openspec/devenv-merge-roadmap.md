# devenv + agentic-coding migration roadmap

## Agreed scope

- Merge into this repository; preserve both applications' features.
- Use devenv's frontend structure as the foundation, selecting/migrating shared components individually rather than replacing either UI wholesale.
- One shell with Environments, Workflows, Observability and Wiki feature tabs.
- One theme/preferences system, modal host, keymap/help contract, panel framing and selection/scrolling concept.
- Use configured devenv apps/libraries for all project discovery. The operator reconciles project locations manually before discovery cutover; no automatic relocation/external-checkout feature.
- TUI owns its backend by default. Explicit server/attach modes remain; attached clients never stop an unowned server.
- Ship the unified frontend with mixed runtimes first. Finish with one Bun/TypeScript backend process and one shipped executable.
- Keep Herdr, Git, agents, container daemons and supported terminal utilities as external domain tools.

## Execution order

Each change contains `proposal.md`, `design.md`, `specs/*/spec.md` and `tasks.md`. All task checkboxes start unchecked. Apply one change at a time in this order; these are implementation dependencies, not merely artifact-generation dependencies.

| # | Change | Required predecessor | Completion outcome |
|---|---|---|---|
| 1 | [import-devenv-into-agentic-coding](changes/import-devenv-into-agentic-coding/proposal.md) | None | Pinned import, one dependency graph, combined verification and feature/route/action parity baseline |
| 2 | [unify-terminal-ui-primitives](changes/unify-terminal-ui-primitives/proposal.md) | 1 | Canonical theme, colors, preferences, modal/panel framing, lists and viewers; component-by-component deletion of duplicates |
| 3 | [compose-unified-feature-shell](changes/compose-unified-feature-shell/proposal.md) | 2 | One renderer, feature navigation, modal/input ownership, discoverable keymaps and root-owned service lifetimes |
| 4 | [replace-workflow-project-discovery](changes/replace-workflow-project-discovery/proposal.md) | 3 + operator project reconciliation | Picker, workflow history, telemetry and CLI use the same configured project catalog |
| 5 | [unify-application-lifecycle-and-binary](changes/unify-application-lifecycle-and-binary/proposal.md) | 4 | **Frontend release:** one executable, TUI-owned lifecycle, embedded Go backend, compatible entrypoints |
| 6 | [expose-unified-bun-backend](changes/expose-unified-bun-backend/proposal.md) | 5 | Typed authenticated API; Bun owns workflow/telemetry, frontend becomes client, Go stays private delegate |
| 7 | [port-project-catalog-and-state-to-bun](changes/port-project-catalog-and-state-to-bun/proposal.md) | 6 | Bun catalog/config/state authority with compatible SQLite and temporary private Go state client |
| 8 | [port-git-providers-and-ai-to-bun](changes/port-git-providers-and-ai-to-bun/proposal.md) | 7 | Bun Git/provider/CI/session/AI services; route-by-route parity and exact action-command ownership |
| 9 | [port-action-execution-to-bun](changes/port-action-execution-to-bun/proposal.md) | 8 | Bun immutable action registry, executor, scripts/process/readiness and temporary runtime adapters |
| 10 | [port-environment-runtimes-to-bun](changes/port-environment-runtimes-to-bun/proposal.md) | 9 | Bun container/Kubernetes/infrastructure capabilities; zero production Go owners |
| 11 | [retire-go-backend-and-migration-bridges](changes/retire-go-backend-and-migration-bridges/proposal.md) | 10 + all parity gates | **Final release:** one Bun backend process, no Go/fallback bridges, integrated supported telemetry |

OpenSpec `status` reports artifact readiness, not completion of preceding changes or operator prerequisites. Do not interpret all proposals being apply-ready as permission to execute them concurrently. Later changes touch contracts and ownership introduced by earlier ones; re-read implemented code/specs before each apply and revalidate affected deltas after predecessors archive. If archived change links move, retain this index's order/names and update links to archive locations.

## Shared migration constraints

1. Preserve workflow definition/behavior pins, capabilities, revisions, read-only observations and durable outbox rules. Do not rewrite the workflow engine while merging applications.
2. Keep environment action semantics distinct: immutable definitions, semantic versus execution identity, one command per executed leaf, typed scoped values, readiness and explicit already-running success.
3. Preserve canonical project identity separately from active checkout and pinned workflow worktree. A configured-project removal is not permission to delete history or stop a workflow.
4. Migrate one UI family with renderer parity checks before removing its old implementation. No duplicate global theme/input/modal state in the final frontend.
5. Every API/state/action/runtime capability has one authoritative mutation owner during cutover. Private adapters are temporary, typed, bounded, authenticated and listed for removal; never shadow real mutations across runtimes.
6. Keep existing domain databases and configuration formats unless an explicit independently reviewed migration is needed. Back up SQLite consistently, stop old writers and never auto-downgrade.
7. Preserve public CLI aliases needed by existing launchers/agents. Internal compatibility wrappers can be deleted once unused; removed historical phase-specific verbs stay removed.
8. Default product command remains `agentic-coding`; canonical UI preferences initially use devenv's configured `tui.json`. Branding/config-root renaming is not part of this migration.

## Readiness gates

### Before change 4

Operator confirms intended configured project IDs, managed checkout locations and retained history. Resolve active workflows with stale absolute paths before cutover. No proposal automatically moves repositories or rewrites their stored locations.

### Before frontend release (change 5)

All existing feature journeys are reachable under one shell. Theme/modal/panel/keymap behavior passes representative renderer tests and interactive footer/help inspection. Packaged artifact works outside both source trees; quit during startup, attach, occupied ports, signals and active work preserve exact resource ownership. Foreground terminal tools use asynchronous waiting so in-process workflow leases continue during the transitional release.

### Before final runtime retirement (change 11)

Every feature/route/action in `agentic-coding/docs/devenv-merge-parity.md` has a tested Bun owner. Go can be disabled without feature loss. Supported optional gRPC works inside the Bun server process; absence of that parity blocks retirement rather than dropping the protocol. Supported historical state and generated assets pass packaged upgrade/read tests.

## Verification

Artifact validation:

```sh
openspec validate --changes --strict --no-interactive
```

Implementation changes must run combined Bun suites, TypeScript checking, Biome with zero diagnostics and Go test/vet until Go is retired. Use host-target `build:single` semantics for local build checks; do not launch real destructive operations against user environments. Record unavailable platform/provider/runtime integration tests as missing coverage, not successful checks.

No application implementation is included in these proposals. Start with:

```text
/opsx-apply import-devenv-into-agentic-coding
```
