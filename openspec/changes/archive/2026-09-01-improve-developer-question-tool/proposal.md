## Why

The managed developer-question flow currently supports only one queued question at a time in the UI and gives custom answers a single-line input, making it difficult for developers to provide structured decisions. Its tool schema and description also provide too little guidance for agents to frame focused, actionable questions and options. A questionnaire-oriented interaction, informed by `rpiv-mono` and `pi-ask-user`, will reduce clarification round trips while preserving the workflow's authenticated, durable question boundary.

## What Changes

- Extend `developer_question` with an ordered multi-question questionnaire payload and a structured per-question response result.
- Add durable validation and lifecycle handling for grouped questions, including bounded content, authentication, expiry/cancellation, stale responses, and dialogue history.
- Redesign the dashboard question modal around question tabs, with clear progress/status, per-question option selection, and navigation across all questions before submission.
- Replace the custom single-line response input with an OpenTUI textarea modeled on the new-workflow task editor, preserving multiline and structured text exactly.
- Improve the tool name, parameter descriptions, and agent-facing guidance so agents ask focused questions, provide useful option labels/values, explain relevant context, and use questionnaires only for related decisions.
- Preserve compatibility for existing single-question calls and FIFO handling of independently queued questions where practical.
- Add focused contract, runtime, renderer, and interaction tests for grouped questions, tab navigation, multiline answers, cancellation, bounds, and response fidelity.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `openspec/specs/workflow-developer-question/spec.md`: expand the authenticated question interface and dashboard modal requirements to cover grouped questionnaires, per-question answers, tab navigation, multiline custom responses, and improved agent-facing question guidance.

## Impact

Affected areas include the developer-question Pi extension (`agent-definitions/extensions/developer-question.ts`), workflow contracts/CLI/runtime (`agentic-coding/src/workflow/contracts.ts`, `src/workflow/cli.ts`, and `src/workflow/runtime.ts`), dashboard question modal and state/key handling (`src/tui/dash/ui/DeveloperQuestionModal.tsx`, `src/tui/dash/App.tsx`, and related data/engine boundaries), generated embedded workflow assets (regenerated through the existing build), and focused tests. No new dependency is expected; the implementation should reuse OpenTUI's native textarea and existing modal/list primitives.
