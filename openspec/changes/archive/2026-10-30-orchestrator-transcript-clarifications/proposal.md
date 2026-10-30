## Why

Workflow clarification should live in ordinary chat with its appropriate orchestrator, not steal focus through a developer-question popup. Decisions must remain attributable, durable and safe across concurrent workflows and recovery.

## What Changes

- Attach workflows explicitly to an appropriate orchestrator, including UI-started workflows.
- Let that orchestrator answer from agreed task/design and recorded decisions without interrupting the developer.
- Otherwise discuss naturally in the transcript and require explicit developer confirmation of the proposed answer before durable delivery.
- Retain discoverable pending questions when no orchestrator is available; preserve lifecycle and authority fences.
- Remove clarification popup presentation, not approval or login/MFA handoffs.

## Capabilities

### New Capabilities
- `orchestrator-transcript-clarifications`: Attached-orchestrator routing, grounded direct answers, confirmed transcript discussion and durable delivery.

### Modified Capabilities

- `workflow-developer-question`: Replace the clarification modal with transcript discussion; preserve authenticated internal requests, bounded structured answers, lifecycle continuation and login handoffs; record answer provenance accurately.
- `home-orchestrator`: Route by explicit session attachment rather than start attribution, support grounded direct answers and confirmed developer decisions, and enforce session-scoped clarification authority.

## Impact

Question contracts/routing and persistence, server authentication/policy, orchestrator tools/prompts and session identity, durable transcript delivery and UI question presentation, plus focused tests and documentation. Existing generic answer/forward actions must not bypass the new confirmation/session checks. Start attribution and review authority remain unchanged. Preserve schema7 with additive compatible records. No deployment, service restart, unrelated QA changes, commits or branch publication.
