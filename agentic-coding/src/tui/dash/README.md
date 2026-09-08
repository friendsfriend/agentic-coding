# Dashboard module map (dashboard-module-boundaries)

One-way ownership split of the per-workflow dashboard (`agentic-coding` TUI).
The shared TUI primitives live in `src/tui/shared/` (consolidate-tui-primitives)
and are imported by the dash family through the thin `ui/` entry points; the
modules below never import each other's feature implementations.

| Module | Owns |
| --- | --- |
| `types.ts` | Shared data shapes (`WorkflowState`, `WorktreeGitStatus`, `LocalChange`, review comment types, `FindingCounts`, `DashboardData`, cost/usage rows, `RequiredUserAction`…). No behavior. |
| `projections.ts` | **Deterministic projections**: typed workflow states, observations, and artifact results in, display data out. `requiredUserActionFor`, `approvalFor`, `agentMetrics`, `costSummary`, `costMessages`, `phaseAgeHours`, `isStale`, `countVerifierFindings`, `phaseStatus`, `agentMetricLine`, `agentRuntimeModelLine`. Every external value (including `now`) is a parameter — no filesystem, Git, Herdr, database, network, timer, or ambient-clock access. |
| `observations.ts` | **Observation and execution I/O**: filesystem/Git/Herdr/telemetry reads, the subprocess observation bridge (`observeAsync`), workflow-engine read/write bridges, committed-artifact integrity checks, in-editor/worktree agent focus, and workflow actions (`runWorkflow`, `answerQuestion`, `applyRepair`…). All external reads live here. |
| `engine.ts` | The repository execution coordinator (owned scheduling of `drainEffects`), workflow-view reads, in-process workflow starts, and `viewToDashboardState`. |
| `review.ts` | **Review feature**: plan/developer/wiki review signals, drafts, in-flight observation controllers, and submission payload construction (`reviewCommentsForEngine`). Explicit typed inputs only (`createReviewFeature(context)`); runs under the App Solid owner, `dispose()` wired into App unmount so extracted state never outlives the component. Uses the displayed engine action IDs/revision and infers nothing from workflow or step identifiers. |
| `demo.ts` | `testDashboard` demo fixture for `--profile test` renders; kept out of every live observation/projection path (demo ownership). |
| `data.ts` | Compatibility barrel re-exporting the former public surface (`observations` + `projections` + `demo` + `types` + engine's `listPresetNames`) so existing callers (CLI observation bridge, tests) keep working. Narrow re-exports only — no duplicated behavior. |
| `App.tsx` | Root composition: layout, keymap layers, lifecycle wiring (refresh watchers, execution coordinator ownership, artifact/observation generation guards), and modal shell rendering. Feature behavior is delegated to the modules above; the root keeps engine action-ID/revision authority and current navigation behavior. |

Dependency direction is one-way: `types` ← `projections` ← `observations` ←
`review`/`App`; `demo` and `data` sit above the leaves. Review submission and
observation ownership never live in the root.