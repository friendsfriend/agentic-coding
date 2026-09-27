# Proposal

## Why

Workflow orchestration and dashboard observation currently depend directly on Herdr CLI arguments, response envelopes, and event transport, which prevents the same product behavior from running on another terminal multiplexer. Luvus now exposes the required UHP operations, so the multiplexer boundary can be made explicit without changing Herdr's established behavior.

## What Changes

- Introduce an Effect-native `MultiplexerPort` of required intent-level operations for workspace, tab, pane, agent, notification, process, and event behavior; callers no longer construct raw Herdr or Luvus transport arguments.
- Move the existing Herdr CLI/schema behavior behind a mechanical adapter, preserving commands, decoding, retry timing, lifecycle order, identifiers, errors, and other observable behavior byte-for-byte; retain a deprecated `HerdrPort` type alias for source compatibility.
- Add a Luvus adapter based on its installed `0.14.2` CLI/UHP schemas, including pane-process discovery, agent launch/prompt lifecycle, event normalization, `--session`, and `LUVUS_SOCKET_PATH` handling.
- Select the adapter from top-level `multiplexer: "herdr" | "luvus"` configuration or `AGENTIC_CODING_MULTIPLEXER`, defaulting to Herdr. An explicitly selected but unavailable runtime fails loudly and never falls back.
- Migrate workflow execution, pane allocation, notification/tab synchronization, dashboard observation/event subscriptions, and detached drain forwarding to the selected port.
- Keep `src/workflow/sidebar-sync.ts` and the Herdr custom Agents view Herdr-specific and unchanged; Luvus sidebar parity and custom notification presentation are deferred.
- Add focused contract, adapter, configuration, failure-policy, event, and migrated-caller tests, plus unchanged Herdr manager/workflow smoke scripts. No new dispatch dependency is introduced.

## Capabilities

### New Capabilities
- `multiplexer-runtime`: Runtime-neutral multiplexer operations, Herdr/Luvus adapter conformance, runtime selection, transport normalization, failure behavior, and deferred Herdr-only sidebar scope.

### Modified Capabilities
- `agent-runtime-routing`: Agent launch, reuse, prompt, status, and stop operations use the selected multiplexer lifecycle rather than requiring Herdr.
- `agent-pane-identity`: Pane liveness and canonical-agent recovery are resolved through the selected multiplexer while preserving canonical and legacy-name behavior.
- `workflow-developer-notifications`: Opt-in workflow notifications are delivered through the selected multiplexer while preserving the existing trusted preference and message policy.
- `dashboard-engine-integration`: Backend pane geometry and runtime event observation use one selected multiplexer boundary instead of a Herdr-only client/socket path.

## Impact

The change adds `src/multiplexer/` port, factory, Herdr, and Luvus modules and migrates the workflow/server call sites that currently import Herdr transports directly. Configuration parsing, detached child environment forwarding, integration contracts, and focused tests are updated. Effect `3.22.2` remains the execution model, and no package dependency is added. Existing Herdr installations remain the default and retain their current CLI-visible and workflow behavior; selecting Luvus requires its executable/session transport to be available.
