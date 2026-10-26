## Why

The durable host reimplements codemode execution even though the installed `@earendil-works/pi-durable@1.4.0` now supplies a native extension. Replacing the adapter can remove duplicated sandbox and nested-call machinery while keeping codemode a user-opted, run-scoped capability.

## What Changes

- Migrate execution to `createCodemodeExtension` from `@earendil-works/pi-durable/codemode`.
- Preserve supported host-mode enablement, offered-tool boundaries, read-only restrictions, useful progress/output, cancellation and safe shutdown unless upstream semantics require an explicitly reviewed change.
- Verify nested-call durability/replay, `store`/`load`, and source/compiled sandbox asset behavior; remove redundant adapter code and update focused tests/docs.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `durable-agent-tools`: specify native codemode execution and the behavioral guarantees the durable host must retain across the migration.


## Impact

- `agentic-coding/src/agent-host/codemode.ts`, durable host extension setup, focused host tests, build asset handling, dependency patch documentation, and codemode user/developer docs.
- Existing `@earendil-works/pi-codemode` patch will be retained unless consumer review and upstream behavior prove it redundant.
