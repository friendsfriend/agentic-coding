## Context

OpenCode exposes a server/SDK mode that could be driven headlessly; Herdr currently provides pane topology, agent detection, prompting and status for it.

## Goals / Non-Goals

**Goals:** no managed agent depends on a multiplexer pane; one dashboard visibility surface.

**Non-Goals:** redesigning the durable host protocol beyond what other runtimes need.

## Decisions

- Evaluate OpenCode's headless server mode as the adapter transport; if it cannot meet the assignment/handoff and observation contracts, retire the OpenCode runtimes instead.
- Generalise the session view's data source behind a runtime-neutral session-view port so non-durable runtimes can feed it.

## Risks / Trade-offs

- [OpenCode headless API instability] → spike before committing; retirement as fallback decision for the developer.
- [Loss of terminal-native interaction] → session view must cover steer/follow-up/abort first.
