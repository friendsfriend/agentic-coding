## Why

Daily cross-system activity needs a durable, read-only digest without creating workflows or routing reports through Home. Named workflowless pi-durable sessions provide an independently selectable destination that survives restarts.

## What Changes

- Add named, independently reopenable workflowless sessions using existing host and transcript primitives.
- Extend existing scheduler admission/execution to bind authenticated ownership and an exact durable session, with idempotent report delivery.
- Add a read-only daily digest task for Jira activity, new Wiz findings through discovered MCP tools via codemode, and new Renovate MRs in discovered local GitLab projects.
- Document safe setup; do not activate a live schedule or collect account-wide data during implementation.

## Capabilities

### New Capabilities

- `daily-task-digest`: Evidence-based, partial-failure-aware daily source collection and reporting.

### Modified Capabilities

- `durable-agent-host`: Add named workflowless session identity and exact-session scheduling without changing workflow-host ownership.

Workflow-agent sidebar rows retain their existing contract; named sessions are separate workspace session entries, not fabricated workflow runs.

## Impact

Scheduler standalone targets, admission, pi-durable session lifecycle and persistence, sidebar selection, source tooling and setup/security documentation. Preserve Home, workflow agents, review controls and existing scheduling behavior. One cohesive change, implemented in verified increments; no deferred feature drafts.
