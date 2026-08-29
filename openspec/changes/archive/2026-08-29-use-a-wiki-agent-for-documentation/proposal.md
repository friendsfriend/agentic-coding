## Why

Documentation is currently an incidental responsibility of planning and archival agents, so it is inconsistently produced and lacks a dedicated OKF-focused prompt. A dedicated wiki agent and review gate will make documentation intentional, reviewable, and human-verified before the change is archived.

## What Changes

- Add a dedicated wiki documentation agent step that researches the landed change and writes or updates OKF v0.2 concept documents as drafts.
- Give the wiki agent explicit prompts for project namespaces, sources, citations, lifecycle metadata, duplicate avoidance, and useful documentation content.
- Remove wiki-authoring responsibility from planning and archival prompts/role paths; the archive agent will remain responsible only for archiving the OpenSpec change.
- Move the existing developer wiki review UI/gate before OpenSpec archival. Wiki comments return to the same wiki agent for revision; approval promotes touched concepts through the engine's human-verification effect.
- Preserve existing non-archive workflows and workflows without OpenSpec archival, and expose the new agent step to routing/profile configuration.
- Add focused workflow, prompt/asset, routing, and review-path regression coverage and regenerate the embedded instruction bundle.

## Capabilities

### New Capabilities

### Modified Capabilities

- `openspec/specs/knowledge-wiki`: document the dedicated wiki-authoring role, its draft lifecycle, and the pre-archive review/approval flow; remove the prior planning/archive authoring and post-archive gate requirements.

## Impact

- Built-in workflow definitions, agent-role resolution, profile/preset step configuration, workflow transitions, and runtime step routing.
- Agent instruction assets and generated embedded assets.
- Existing wiki review flow and its workflow integration tests; no new UI review component or external dependency is required.
