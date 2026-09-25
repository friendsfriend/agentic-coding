# Proposal

## Why

Every verifier role currently launches into one shared `verification` tab that is split repeatedly `down` into a grid, so a run with several selected verifier roles produces a stack of two-row panes the developer cannot tell apart or check at a glance. Each verifier is already an independent Herdr agent with a stable per-role identity, so the shared tab is a layout choice, not an identity requirement.

## What Changes

- Give each verifier role its own Herdr tab labeled `<status glyph> <role>` (for example `● quality-verifier`, `✓ test-verifier`) at full tab height, instead of splitting a shared `verification` tab.
- Decouple pane-layout grouping from agent naming in the step behavior: `core.verification` keeps `roundScoped: true` for canonical agent naming but resolves its layout group per run role, while `core.triage` keeps its own `triage` tab unchanged.
- Reuse each verifier role's existing live agent/tab on later verification rounds and fix loops; no duplicate tab is created for the same role in a later round.
- Keep UI grouping in the one workflow workspace plus the existing Herdr sidebar Agents tree; no tab-group primitive is added to Herdr.
- Update the `herdr-workflow-prompting` spec (the shared-verification-tab requirement and scenarios), the `agent-tab-status` shared-tab example, workflow architecture docs, step-behavior comments, and the verification pane-allocation tests.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `herdr-workflow-prompting`: the requirement that verifiers share one tab is replaced by per-role verifier tabs that are stable and reused across rounds; triage keeps its own tab.
- `agent-tab-status`: the shared-tab aggregation example names the verification group, which no longer shares a tab; the generic multi-role aggregation behavior stays, and a reused-pane run reconciles onto the tab it actually occupies.

## Impact

- `agentic-coding/src/workflow/steps/types.ts` (`StepBehavior` layout-group flag) and `agentic-coding/src/workflow/steps/verification.ts` (`core.verification`, `core.triage`).
- `agentic-coding/src/workflow/cli/pane.ts` (`paneGroup`, `paneForRunFactory`, sibling filter) with comments.
- `agentic-coding/src/workflow/tab-status.ts` / `tab-sync.ts` comments only; labeling and reconcile semantics stay unchanged.
- `agentic-coding/docs/workflow-architecture.md` pane-group note.
- Focused tests: `agentic-coding/test/workflow-cli.test.ts` verifier/triage pane-allocation cases.
- No changes to agent identity derivation (`canonicalAgentName` / `legacyRunName`), the dashboard/git tabs, or the Herdr sidebar integration.
