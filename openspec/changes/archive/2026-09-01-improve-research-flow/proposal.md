## Why

The `research` workflow's handoff from researcher to wiki agent does not really exist. When the developer dispatches `request-research-wiki`, the runtime only makes a best-effort, optional attempt to read whatever the researcher's run happened to leave at its output path (a slot the researcher is never actually allowed to fill, since its run only permits `blocked`/`failed` outcomes). In practice the wiki agent starts with the raw task and a truncated tail of follow-up messages, not the researcher's actual findings, subject, canonical target, or citations. Nothing requires the researcher to hand anything off before the developer destroys its run and starts the wiki agent, so the wiki draft is frequently disconnected from what the researcher actually found.

## What Changes

- Require the researcher to author a structured handoff (subject, canonical wiki target if known, findings/outline, and source citations) while still interactively active, before the developer can request wiki drafting.
- Make the `request-research-wiki` action reject the request (with an actionable message) when no valid handoff has been recorded yet, instead of silently proceeding without one.
- Only after a valid handoff is captured does the workflow expire/stop the researcher run and launch the `core.wiki` stage.
- Replace the current best-effort, size-truncated, optional summary read with the full captured handoff content as the required, primary input the wiki agent receives (in addition to the task and repository context it already gets).
- Update the `researcher` and `wiki` agent instructions to describe the mandatory handoff step and its role as authoritative input to wiki drafting.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `research-workflow`: the researcher must record a structured handoff before `request-research-wiki` can succeed, the action must reject the request when no valid handoff exists, the researcher run is only expired/stopped after a valid handoff is captured, and the `core.wiki` stage receives that full handoff content as its primary input instead of a best-effort optional summary.

## Impact

- `agentic-coding/src/workflow/definitions.ts` — `core.research` step/workflow-edge definitions (outcomes, run-level allowed outcomes for the researcher role).
- `agentic-coding/src/workflow/runtime.ts` — `request-research-wiki` action handler (currently optimistic/optional summary read) and the mechanism by which the researcher records a handoff during its interactive session.
- `agentic-coding/src/workflow/assignment.ts` — researcher/wiki role assignment context construction.
- `agentic-coding/src/workflow/effect-runner.ts` — any research-step effect handling touched by the new handoff mechanism.
- `agent-definitions/instructions/research.md` — researcher instructions for the mandatory handoff step.
- `agent-definitions/instructions/wiki.md` — wiki agent instructions describing the guaranteed handoff input.
- `agentic-coding/test/workflow-runtime.test.ts` — focused coverage for the new gating and context-propagation behavior.
- `openspec/specs/research-workflow/spec.md` — requirement updates described above.
