## Why

The shared durable host currently resolves percentage-based compaction against the smallest model window among its tracked runs, so one conversation can change another conversation's thresholds. Native pi-durable per-model compaction offers a way to isolate policy by exact provider/model identity while retaining Agentic Coding's defaults, live settings, cost ceiling, and failure/recovery UI.

## What Changes

- Replace shared minimum-window policy resolution with live policies for each conversation's actual model, using native `settings.compaction.modelOverrides` where its released contract supports the behavior.
- Preserve absolute versus percentage configuration semantics, current defaults and clamps, user-scope precedence, per-run/model settings and token budgets, and cost-ceiling admission/loop guards.
- Audit threshold checks, overflow recovery, and summarizer-model selection independently; compare native behavior before removing any host logic.
- Add isolated deterministic host/config/UI regressions and document effective policy precedence. The pinned 1.4.0 contract and approved host workaround are documented in design.md.

## Capabilities

### New Capabilities

None proposed; this extends existing durable compaction/configuration behavior.

### Modified Capabilities

- `durable-agent-compaction`: actual-model policy resolution, exact override precedence, and conversation-scoped summarizer serialization (with the approved pre-upgrade checkpoint boundary).

## Impact

Primary change: `native-per-model-compaction`; one cohesive implementation, no follow-up changes currently proposed. Expected surface: `agentic-coding/src/workflow/compaction.ts`, `src/agent-host/host.ts`, direct configuration/settings readers and UI labels, focused tests and documentation. No workflow lifecycle changes, compatibility shims, storage migrations, remote MCP/Pi tool bridging, broad telemetry work, or running developer-service restarts/rebuilds.
