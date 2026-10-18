## Why

The `cap-orchestrator-launches` ceiling was a safety net against a misread
request or a retry loop in the model. The developer has since verified the
orchestrator's launch behaviour is sensible and no longer wants any cap on how
many workflows the orchestrator may spawn, so both bounds — the active count
(`max_active`, default 5) and the trailing-24 h start count
(`max_starts_per_day`, default 20) — are dead weight: they refuse work the
developer asked for, and they are the only reason the server reads every
workflow store before an orchestrator start.

## What Changes

- **BREAKING**: Remove `[agents.orchestrator] limits` and both bounds. A
  configuration that still contains the table is refused with the parser's
  normal `unsupported key limits` error; there is no compatibility shim and no
  `STORE_SCHEMA_VERSION` change.
- Remove the `409 orchestrator-limit` refusal and its `limit.hit` event from the
  server policy, the transport, the config/agents read, and the Settings
  inventory; the orchestrator launch-count read and its module are deleted.
- Keep every other orchestrator policy intact: route allowlist, action
  allowlist, human-review steps, the human-review gate pin, ownership and
  provenance, and blueprint validation.
- Remove the requirement text, event catalog entry, docs and prompt guidance
  that named either bound.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `home-orchestrator`: no orchestrator launch ceiling; orchestrator starts are
  never refused or counted for how many workflows exist.
- `workflow-event-stream`: the catalog no longer carries `limit.hit`, and no
  refusal event is recorded because nothing refuses a start.

## Impact

- `src/server/orchestrator-policy.ts`, `app.ts`, `handlers.ts`, `config.ts`;
  `src/workflow/profiles.ts`; `src/workflow/runtime/orchestrator-launches.ts`
  (deleted); `src/contracts/{actions,gateway,workflow-events}.ts`;
  `src/server/workflow-event-bus.ts`; `src/tui/{settings,otel/app,dash,orchestrator}`
  readers and the Settings inventory.
- No route is added, renamed or deleted. `STORE_SCHEMA_VERSION` stays 6, and no
  migration or compatibility reader is introduced: the removed keys are simply
  unsupported.
- Tests, `docs/orchestrator.md`, `docs/settings-inventory.md` and the
  `home-orchestrator`/`workflow-event-stream` specs are updated with the
  removal.
