## Why

After `add-pi-durable-runtime` makes the bundled `pi-durable` runtime the default, the legacy `pi` runtime keeps a second launch path, pi extension files, global-tool parity code, a `pi install` wrapper, and pi session discovery alive. Retiring it removes duplicated protocol tooling and the external `pi` executable dependency.

## What Changes

- **BREAKING:** remove the `pi` runtime id, `PiAdapter`, and `pi` model enumeration; configurations naming `pi` are rejected with a migration diagnostic pointing to `pi-durable`.
- Remove `src/workflow/pi-tools.ts`, `piLaunchAssets`, the `agent-extension` CLI, and the pi extension/bridge files under `agent-definitions/` once nothing loads them.
- Replace pi session discovery in the server integrations with durable host session listing.
- Provide a config migration that rewrites `runtime: "pi"` profiles/presets to `pi-durable` (preview by default).

## Capabilities

### New Capabilities
- `legacy-pi-runtime-retirement`: rejection and migration of `pi` runtime configuration and removal of pi-only surfaces.

### Modified Capabilities

## Impact

`src/workflow/adapters.ts`, `profiles.ts`, `pi-tools.ts`, `agent-extensions.ts`, `effect-runner.ts`, `src/server/integrations/pi-sessions.ts`, `src/config-migration.ts`, `agent-definitions/extensions`, `agent-definitions/bridges/pi-telemetry.ts`, README, install script. Depends on `add-pi-durable-runtime` being archived.
