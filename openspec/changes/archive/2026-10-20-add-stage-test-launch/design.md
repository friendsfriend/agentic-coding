## Context

Architecture and phasing: `openspec/changes/add-stage-testing-foundation/design.md` (D8). Phase 3 adds the `stage-test` family, the `stage` metadata and its start validation; this change only adds the two human-facing ways to start it. Verified: independent work starts from Wiki (`openspec/specs/contextual-workflow-launch/spec.md`); the orchestrator has only `read` and its workflow tools and starts through the unified server with its capability (`openspec/specs/home-orchestrator/spec.md`, "Orchestrator tool surface"); `WorkflowMetadata.ticket` already exists (`agentic-coding/src/contracts/workflow.ts:285`).

## Goals / Non-Goals

**Goals:** ticket text in from the dashboard or the orchestrator; stage choice from the allow-list only.

**Non-Goals:** fetching ticket text from a ticket system; starting from an application page (a stage spans several applications); a stage editor.

## Decisions

- **Start from the independent-work form**, because a stage test is repository-independent like research; a repository context stays optional. Rejected: a new top-level destination (one more surface for one form).
- **Picker from the catalog route** of phase 1, so the dashboard never offers a stage the server would refuse; excluded stages are listed disabled with their first diagnostic so the developer sees why.
- **Orchestrator** passes `stage` through `start_workflow`; the server validates it. The guidance adds "stage" to the facts the developer must establish, in line with "Before starting a workflow".
- **Ticket seam** = existing `ticket` metadata; a future resolver fills `task` from it at start. Nothing in this change calls a ticket system.

## Risks / Trade-offs

- [Long pasted ticket text] → the task field keeps the existing task size bound; the planner summarises it in the plan.
- [Orchestrator guesses a stage] → the server refuses unknown stages; guidance forbids picking a stage the developer did not name unless exactly one allow-listed stage exists for the named system and the developer confirms it.
