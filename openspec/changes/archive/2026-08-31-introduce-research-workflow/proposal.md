## Why

The repository currently supports finite implementation and documentation workflows, but it has no managed workflow for open-ended knowledge gathering. Users need a researcher that can investigate a question, use follow-up dialogue to refine the result, and remain active until the user explicitly decides the research is complete.

## What Changes

- Add a selectable, versioned `research` workflow with the lifecycle `core.research → core.wiki → core.wiki-approval → core.closed`.
- Add a dedicated researcher agent/skill that supports web and repository-context research using tools available to the selected runtime, without requiring a new web integration.
- Support both standalone research and optional read-only repository context.
- Keep the researcher session available for follow-up questions; ordinary agent output or runtime settlement must not finish the workflow, and only the developer's explicit `request-research-wiki` action may enter wiki drafting.
- Let the user explicitly close the research stage at any time with a dedicated `close-research` action.
- Allow the user to explicitly request a draft knowledge-wiki entry; the researcher hands off to a dedicated wiki drafting stage, followed by developer approval through the existing centralized wiki conventions.
- Do not introduce implementation, review, delivery, archive, or pull-request stages into this workflow.

## Capabilities

### New Capabilities

- `research-workflow`: Interactive, persistent research lifecycle with optional repository context, wiki drafting, developer approval, and explicit closure.

### Modified Capabilities

- `workflow-definition-registry`: Register and expose the research, wiki, and wiki-approval steps as a bounded workflow graph with explicit lifecycle behavior.
- `workflow-agent-assignment`: Extend assignment, routing, persistence, and handoff semantics for the dedicated researcher role and its ongoing dialogue.
- `workflow-state-runtime`: Support developer `request-research-wiki` and `close-research` actions while research is active and preserve the workflow as active until one is committed.
- `knowledge-wiki`: Permit an authenticated researcher run to create/update draft concepts when explicitly requested, while retaining centralized OKF conventions and human-promotion safeguards.

## Impact

The workflow registry/runtime, start validation and action exposure, routing/profile resolution, assignment construction, researcher and wiki instruction assets, wiki authorization, approval effects, dashboard views, and focused workflow tests will change. The workflow must support an empty repository identity for standalone runs while retaining optional repository metadata and read-only repository permissions when context is supplied. No new web provider dependency or integration is required; tool availability remains runtime/profile configuration.