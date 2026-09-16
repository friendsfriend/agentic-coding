## Why

Agent model and preset configuration currently lives in the workflow home dashboard, which will be removed. Users need one Settings destination for existing appearance, provider, project, runtime and agent configuration rather than unrelated editors scattered across feature views.

## What Changes

- Add Home → Settings with Appearance, Agent models/presets, Providers/credentials, Projects/environments and Backend/telemetry sections.
- **BREAKING** Move persistent agent profile/preset editing out of workflow home into Settings; remove the old entry after parity is established.
- Reuse configuration readers, writers and editors; make every supported application setting reachable here, including settings currently edited only through documented files.
- Show effective value, source and scope; application/library settings shortcuts open the same Settings implementation with project scope.
- Preserve protected credential storage, config precedence, unknown fields, validation and running-workflow pins.

## Capabilities

### New Capabilities
- `centralized-application-settings`: Unified settings navigation, completeness inventory, scopes and safe persistence.

### Modified Capabilities
- `agent-configuration-presets`: Settings owns profile/preset management and catalog-driven editor behavior instead of dashboard home.

## Impact

Depends on `replace-nested-tabs-with-page-navigation`. Reuses `src/tui/dash/ui/ModelConfigModal.tsx`, current theme/preferences components, imported provider/project configuration flows and existing typed server configuration APIs. Paths are relative to `agentic-coding/`. Missing supported editors require bounded sections/adapters, not a new generic form engine or merged config database.
