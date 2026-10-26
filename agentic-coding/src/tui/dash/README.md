# Dashboard module map (dashboard-module-boundaries)

One-way ownership split of the per-workflow dashboard (`agentic-coding` TUI).
The shared TUI primitives live in `src/tui/shared/` (consolidate-tui-primitives)
and are imported by the dash family through the thin `ui/` entry points; the
modules below never import each other's feature implementations.

| Module | Owns |
| --- | --- |
| `types.ts` | Shared data shapes (`WorkflowState`, `WorktreeGitStatus`, `LocalChange`, review comment types, `FindingCounts`, `DashboardData`, cost/usage rows, `RequiredUserAction`…). No behavior. |
| `projections.ts` | **Deterministic projections**: typed workflow states, observations, and artifact results in, display data out. `requiredUserActionFor`, `approvalFor`, `agentMetrics`, `costSummary`, `costMessages`, `phaseAgeHours`, `countVerifierFindings`, `phaseStatus`, `agentMetricLine`, `agentRuntimeModelLine`, `classificationEntries` (the merged classification history), `classificationRows`, `classificationDetail`. Every external value (including `now`) is a parameter — no filesystem, Git, database, network, timer, or ambient-clock access. |
| `observations.ts` | **Observation and execution I/O**: filesystem/Git/telemetry reads, the subprocess observation bridge (`observeAsync`), workflow-engine read/write bridges, committed-artifact integrity checks, and workflow actions (`runWorkflow`, `answerQuestion`, `applyRepair`…). All external reads live here. |
| `launch.ts` | **Contextual workflow launch**: the immutable launch context (configured project identity or independent Wiki target), the workflow types a context may offer, project availability checks, and the classification of a start result into accepted / rejected / uncertain plus the bounded post-acceptance handoff report. The one place the full application decides a target. |
| `engine.ts` | The repository execution coordinator (owned scheduling of `drainEffects`), workflow-view reads, in-process workflow starts, and `viewToDashboardState`. |
| `review.ts` | **Review feature**: plan/developer/wiki review signals, drafts, in-flight observation controllers, and submission payload construction (`reviewCommentsForEngine`). Explicit typed inputs only (`createReviewFeature(context)`); runs under the App Solid owner, `dispose()` wired into App unmount so extracted state never outlives the component. Uses the displayed engine action IDs/revision and infers nothing from workflow or step identifiers. |
| `demo.ts` | `testDashboard` demo fixture for `--profile test` renders; kept out of every live observation/projection path (demo ownership). |
| `data.ts` | Compatibility barrel re-exporting the former public surface (`observations` + `projections` + `demo` + `types` + engine's `listPresetNames`) so existing callers (CLI observation bridge, tests) keep working. Narrow re-exports only — no duplicated behavior. |
| `evidence-panel.ts` | **Evidence view model**: the one-line kind summary (`evidenceKindSummary`), the panel's height budget, the report entry (`evidenceReportEntry`), the sidebar's rows — flow grouping when the workflow has a stage journal, debug-request grouping otherwise — and the entry/step labels and metadata lines. Pure: no I/O, no clock. |
| `evidence-report.ts` | **Report view model**: the wiki's citation marker (`[^<evidence-id>]`) resolved against the manifest, the rewritten markdown (control characters folded out, so a report cannot paint escape sequences), the cited-screenshot sections (capped) and the sources rows, plus the kitty capability probe the report mounts images on. Pure; the route owns the reads. |
| `evidence-open.ts` | **Evidence actions**: the entry's local path, the external open of one entry and of `stage-flow.html`. |
| `panels/EvidencePanel.tsx` | The Evidence panel row: the kind-count summary with its `report`/`flow`/empty-state markers and the loading/error message. `Enter` opens the subview; the panel itself offers no mutating action. |
| `ui/EvidenceSubview.tsx` | The evidence subview page: the report pane (markdown blocks, cited screenshots inline when their bytes land or as a text fallback, sources) beside the sidebar list of every entry with the focused row's metadata, the sidebar's three read-state lines (loading, failed with its reason, nothing attached yet), and the page's own keys (selection, both file actions, report scroll, `Esc`). |
| `App.tsx` | Root composition: layout, keymap layers, lifecycle wiring (refresh watchers, execution coordinator ownership, artifact/observation generation guards), and modal shell rendering. Feature behavior is delegated to the modules above; the root keeps engine action-ID/revision authority and current navigation behavior. |

Dependency direction is one-way: `types` ← `projections` ← `observations` ←
`review`/`App`; `demo` and `data` sit above the leaves. Review submission and
observation ownership never live in the root.
## Pointer input (tui-mouse-navigation)

Mouse handling is additive: no key binding changed and the keyboard remains the
first input. The semantics live once in `@agentic-coding/ui`
(`packages/ui/src/components/mouse/`) and the dashboard only composes them:

- a tap on a panel title or body focuses that panel (the `J/K/H/L` equivalent),
  a tap on a list row selects it, a tap on the already-selected row runs the
  row's `Enter` action, and a double tap selects then activates once;
- the panel grid, the detail panels and every dialog pass `onSelect`/
  `onActivate`; activation not otherwise reachable is expressed as the surface's
  own key (`useKeyDispatch`) so the keymap keeps deciding what is available;
- the wheel moves the cursor of the windowed list under the pointer (the pane
  the pointer is over, never the focused one); transcript/detail scroll boxes
  scroll natively;
- a dialog names its `dismissKind`, and the shared policy decides whether a
  backdrop tap may dismiss it (read-only dialogs yes, a wizard, secret, typed
  draft or irreversible confirmation no);
- footer and modal key chips dispatch the key they advertise
  (`useKeybindChips`); a chip whose label is not a single stroke (`j/k`) stays
  inert.

`test/dash/mouseInteraction.test.tsx` asserts the tap/drag/wheel/dismiss rules
at the renderer boundary; `test/ui/mouseInteraction.test.ts` asserts the pure
rules.
