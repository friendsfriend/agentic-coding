## Why

V2 durable agents currently have native coding/delegation/environment tools but no mandatory native codemode or user-level Pi integration surface. Add these consistently without a second agent runtime, unsafe replay, implicit project trust, or integration initialization during administrative cleanup.

## What Changes

- Select `createCodemodeExtension` from `@earendil-works/pi-durable/codemode` for every durable root/project orchestrator, interactive workflow and nested task/verifier/fixer. Keep explicit standalone no-tools chat unchanged; reviewer restrictions remain prompt-only.
- Import user-level Pi MCP tools through direct clients/transports and compatible extension tools through a headless adapter, never a Pi session, Pi process, extra model or second runtime. V1 is reference material only.
- Preserve real native discovery, all five exposure modes, collision-safe identities, actual cwd, native nested execution, cancellation, bounded results/progress and replay-unsafe external calls.
- Add event-driven late-registration reconciliation and isolated bounded owners with complete lifecycle disposal; keep config/credentials in place and read-only, state/cache/logs v2-owned.
- Keep stopped-host `--clear-finished-tasks` integration-inert and provide source/bundle QuickJS assets.
- Make unsupported/auth/unavailable states visible and sanitized; UI-only registration is not grounds for blanket rejection, but required safety/session semantics must never be silently discarded.
- Gate implementation on an approved public-API loading strategy. Initial static inspection proved codemode/client support at 1.4.0, but not a safe, fully configurable user-only extension loading path. The developer subsequently explicitly authorized upgrading to 1.5.2 before implementation; that dependency-only upgrade is applied. 1.5.2 does not close the loading gap, and existing v2 call sites require compatibility migration before feature work.

## Capabilities

### New Capabilities

- `v2-native-tool-integrations`: V2-only codemode, public-API compatibility boundary, direct MCP/headless extension integration, exposure/discovery, isolation, replay and lifecycle contracts, inert maintenance and isolated acceptance.

### Modified Capabilities

None. Existing `local-pi-tool-bridge` and `durable-agent-tools` describe v1 behavior (including session/UI exclusions and reviewer capability restrictions) and are not rewritten to accidentally change v1. This capability explicitly scopes the different v2 contract to `agentic-coding-v2`.

## Impact

Expected v2 call sites: `src/runtime.ts`, `src/skill-task.ts`, `src/agent-tools.ts`, `src/orchestrators.ts`, `src/task-retention.ts`, `src/cli.ts`, new focused integration/codemode modules and tests, and `scripts/build.ts`. `src/standalone.ts` is a regression-test boundary, not a feature-expansion target. Dependency declarations/lockfile may change only after explicit approval of the API strategy; direct imports of transitive pi-codemode/pi-mcp/QuickJS require explicit dependency ownership.

The initial proposal changed OpenSpec only. Following explicit developer direction, the four existing Pi/chord direct dependencies and lockfile are upgraded to exactly 1.5.2, with lifecycle scripts disabled. No application implementation changes are made. Remain in the current checkout on `feat/agentic-coding-v2`; no worktree, merge or push. No `src/web/*`, manual `embedded.generated.ts`, overwritten telemetry/unrelated target/discovery tests, or recreated `docs/`. No real integration initialization, live provider/MCP requests, deployment, credential edits or host restart without separate approval. The originating developer request is authoritative; detailed constraints and the review/check plan are retained in design/tasks.
