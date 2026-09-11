## Why

After all production capabilities are Bun-owned, retained Go binaries, private adapters and duplicated build paths become maintenance and ownership hazards. Final cleanup must prove parity rather than hide remaining gaps by removing features.

## What Changes

- Remove Go runtime/build/extraction paths and migration-only transport adapters after route, action and feature inventories show no remaining owners.
- Consolidate optional telemetry gRPC into the Bun server process with protocol and shutdown checks.
- Keep one executable with TUI, server, attach and compatible workflow/dashboard entrypoints.
- Remove obsolete UI import wrappers and duplicate launch paths; retain supported public aliases and historical data compatibility.
- Publish final platform/upgrade documentation and run packaged full-feature acceptance.

## Capabilities

### New Capabilities

- `single-bun-application`: One Bun backend process, one shipped executable and verified feature/data compatibility without Go.

### Modified Capabilities

None; final architecture realizes the server API target introduced earlier.

## Impact

Depends on `port-environment-runtimes-to-bun` and completion of every migration parity gate. Deletes imported Go runtime source/build dependencies and temporary bridges only after TS equivalents pass. Herdr, Git, agents, container/cluster tools and supported external utilities remain explicit external dependencies.
