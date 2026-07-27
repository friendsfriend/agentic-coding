# Tasks — architecture-checkup-round-1

This change is a spec-only analysis catalog. "Implementation" means authoring and validating the catalog content; no engine, dashboard, or config code is touched.

## Catalog authoring

- [x] **T1** Write the `agentic-coding-consolidation` spec capturing the target architecture: single TS `agentic-coding` binary with `workflow`/`dash`/`home`/`manager` surfaces, engine imported in-process, Python retired, `otel-tui` separate.
- [x] **T2** Record the CLI-compatibility requirement: agent-facing `herdr-workflow <verb>` invocations and the `PLAN_REJECTED` loop keep working via a `herdr-workflow` → `agentic-coding workflow` shim.
- [x] **T3** Record the ranked backlog R1–R8 as requirements, each with tier, effort, concrete evidence (file/line), and a target-state invariant scenario.
- [x] **T4** Record the layout-state-is-not-workflow-state finding (R3) with the exact leaked fields (`verificationSecondRowPane`, `verificationSecondRowRole`, `verificationPaneOrder`).
- [x] **T5** Record the otel viewer duplication finding (R6) naming the duplicated modules (`otel-tui.tsx`, `TraceBrowser`, `traces.ts`, `receiver`).

## Validation

- [x] **T6** Cross-check every evidence claim in the catalog against current source (phase-list order divergence, missing TS `WorkflowState` fields, `commands.py` LOC, `.result` parse count, agent-name truncation) and confirm each is accurate.
- [x] **T7** Confirm the catalog scope: no source, config, or test files are modified by this change (`git diff --name-only` touches only `openspec/changes/architecture-checkup-round-1/`).
- [x] **T8** Run `openspec validate architecture-checkup-round-1` and resolve any structural errors.
