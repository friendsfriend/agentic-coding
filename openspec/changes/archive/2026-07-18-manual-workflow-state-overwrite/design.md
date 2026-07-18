# Design: manual-workflow-state-overwrite

## Scope

Add developer-only phase repair without changing normal transition validation. Repair recovery file handoff; recovery remains analysis plus explicit dashboard confirmation, not an autonomous state mutator.

## Phase override

`herdr-workflow override-phase --repo <repo> --change <change> <phase>` accepts only active operational phases:

`explore`, `proposed`, `apply`, `fix`, `triage`, `verify`, `paused`, `developer-review`, `archive`, `completed`.

`closed` remains owned by `close`, which also closes Herdr workspace. Unknown targets fail before any write. Unlike `phase`, override does not consult allowed transition graph. It calls existing `set_phase()` and `save_state()`, preserving verification records, panes, branch metadata, and all other fields. It emits `workflow_phase_overridden` telemetry with prior and target phases.

Dashboard exposes this command through a `Shift+O` phase list and a separate confirmation view naming both phases. It is available even when agents appear working: recovery must work for stale agent status. Selecting a phase does not launch, stop, or message agents; it only repairs persisted phase. Dashboard refreshes state after command result. CLI remains escape hatch when dashboard cannot open.

## Recovery artifact handoff

Each `recover` request creates a fresh recovery identifier, removes any prior `recovery-plan.json`, and writes identifier plus current phase, verification state, and allowed recovery context into `recovery-context.json`.

Recovery prompt and role skill name exact output file:

`.herdr-workflow/<change>/reviews/recovery-plan.json`

They require use of write tool to create JSON before ending, prohibit putting plan JSON in chat, and require plan identifier. A valid plan is exactly one allowlisted action (`retry-verification`, `dispatch-triage`, or `record-verifier-result` with valid role) plus matching recovery identifier. This removes ambiguous "Output plan only" wording that allowed chat-only JSON.

Dashboard only presents a plan matching current recovery identifier. `apply-recovery` revalidates identifier, action shape, and phase/action compatibility before dispatching existing command handlers. Missing, stale, malformed, or incompatible plans fail without changing workflow state. Existing confirmation modal remains gate before execution.

## Invariants

- Normal `phase` transition graph remains unchanged.
- Manual override changes phase and phase timestamp only; it does not manufacture verification outcomes or agent lifecycle changes.
- Override never directly sets `closed`.
- Recovery agent remains restricted and cannot mutate workflow state itself.
- Controller remains final authority for recovery plan validation and execution.

## Validation

Add focused CLI regression coverage with temporary workflow state for valid override, invalid/closed target rejection, preservation of unrelated state, synchronized state writes, telemetry event, stale-plan removal, and recovery plan identifier/action checks. Run it with existing workflow script conventions. Run `bun run type-check` in `agent-dash` for dashboard changes and `openspec validate manual-workflow-state-overwrite --strict` for artifacts.
