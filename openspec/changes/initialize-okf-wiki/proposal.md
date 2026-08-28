## Why

Future planners need a durable, centralized record of repository architecture and operational constraints instead of rediscovering them from source on every change. Seed the shared OKF wiki now from the current repository so later planning can consult concise, provenance-backed drafts.

## What Changes

- Create or update a small set of centralized OKF concepts under `~/.config/agentic-coding/wiki` through the existing `agentic-coding workflow wiki` command surface.
- Capture current facts about architecture, workflow lifecycle and roles, validation commands, configuration, dashboard boundaries, runtime adapters, and telemetry.
- Preserve existing related concepts by searching first and updating in place; write all seeded concepts as `draft` with repository path sources and explicit uncertainty labels where applicable.
- Read every written concept back with `wiki show` and validate the resulting bundle and provenance.
- Do not change application source, tests, workflow behavior, Git history, or promote any concept to verified status.

## Capabilities

### New Capabilities

- `repository-knowledge-seed`: Seed a small set of current repository-knowledge concepts in the existing shared OKF wiki as draft, provenance-backed documents.

### Modified Capabilities

None. The existing `knowledge-wiki` behavior is unchanged.

## Impact

- Affected output: the centralized OKF bundle selected by `HERDR_WIKI_DIR`, `[wiki] root`, or its default location; existing concepts may be updated in place.
- Evidence sources: repository documentation, workflow engine and registry, runtime/configuration seams, dashboard data/UI, development scripts, and shipped `pi/herdr-workflow.toml`.
- No application files, tests, workflow definitions, or existing OpenSpec requirements are changed. The new capability specification describes the requested documentation output; it does not alter application runtime behavior.
