## Context

Depends on `port-environment-runtimes-to-bun` and every preceding parity gate. No production route or action should still require Go. This change realizes one Bun backend process and one executable, not merely one installer around multiple permanent servers.

## Goals / Non-Goals

**Goals:** Delete migration-only runtime/build code, preserve all supported features/data/aliases and prove source-independent packaging.

**Non-Goals:** Rename product/config roots, remove public compatibility commands, replace external Herdr/Git/agents/tools, or merge databases.

## Decisions

1. Treat the parity inventory and route/action ownership manifest as deletion gates. There must be zero Go production owners and no fallback-on-error path that silently invokes Go. Retain portable golden fixtures from Go tests in Bun suites before deleting Go source/tests/build dependencies. No feature can disappear merely because its replacement is incomplete.
2. Remove embedded-Go extraction, Go compiler requirements, private state/operation/runtime clients and multi-runtime health fields. Keep the one public Bun server API and TUI-owned launch model. TUI and server can be separate invocations of the same executable; all backend domains run in one Bun process. External container daemons and agent processes are not backend runtime duplication.
3. Integrate supported gRPC receiver into Bun server lifecycle using a verified compatible library/runtime path. Test actual protocol decoding, bound address, readiness, forwarding/persistence and shutdown. Do not claim metrics/log gRPC support if baseline only supported traces. If in-process compatibility is not achieved, this final change is blocked rather than redefining the single-backend-process goal.
4. Remove internal UI compatibility wrappers only when imports are gone, retaining supported `devenv`, home/manager/dash and workflow entrypoints as thin route/command aliases. Deprecated removed phase/role verbs remain removed. Retain versioned workflow definitions, historical snapshots and config/data compatibility independently from internal source cleanup.
5. Build includes generated instructions, guides, native OpenTUI resources and telemetry protocol assets. Test from outside source checkout with no Go toolchain and no external devenv checkout. Publish explicit runtime-tool/platform support matrix and safe upgrade/backup instructions.

## Risks / Trade-offs

- Hidden fallback retains second backend → static import/process checks plus run with Go unavailable and assert process inventory.
- Deleting historical definitions strands workflows → preserve pin/digest fixtures and version retention tests.
- Optional gRPC blocks final milestone → complete in-process compatibility before deletion; do not silently drop protocol.
- Rollback to old schema writer damages state → stop all writers and restore verified pre-upgrade backup if needed; never auto-downgrade.

## Migration Plan

Freeze green parity inventory; transfer remaining fixtures; disable Go entirely and run full acceptance; integrate gRPC; delete bridges/source/build paths; run clean packaged install/upgrade/attach/shutdown tests. Tag the last mixed-runtime release as rollback artifact. Rollback remains deliberate artifact/data restoration at a quiescent boundary, not runtime fallback.

## Open Questions

No blocking product choices. Final acceptance requires access to supported runtime/platform test environments or an explicit coverage record; absence is not a passing test.
