## Why

Effect conventions do not help agents if engine operations still require a second model for synchronous exceptions, ambient dependencies, and manual store ownership. Migrate the workflow application and transactional runtime to the same typed execution model while retaining the existing durable authority and pure step decisions.

## What Changes

- Expose workflow application operations as Effect programs with explicit expected failures and concrete service requirements.
- Migrate canonical store access, explicit initialization/migration, command processing, reads, claims, renewal, capability/evidence operations, and repair/migration previews.
- Migrate startup, configuration I/O, executable/model preflight, and source evidence preparation to Effect service boundaries; keep pure routing and step logic deterministic.
- Keep SQLite write transactions short, synchronous, atomic, and free of suspending Effect execution or external asynchronous work.
- Preserve the prerequisite observation/execution separation and step-owned completion behavior instead of creating alternate mechanisms.
- **BREAKING:** Internal synchronous engine/startup APIs become Effect APIs. Transitional callers use inventoried outer bridges; CLI/JSON, store schema, and workflow semantics remain compatible.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-engine-runtime`: Effect-native application operations and concrete dependency provision.
- `workflow-state-runtime`: Scoped store ownership, safe interruption boundaries, and Effect-native evidence/security integration.

## Impact

- Depends on `adopt-workflow-effect-foundation`, `version-workflow-store-migrations`, `separate-workflow-observation-execution`, and `centralize-step-completion-behavior`; their existing prerequisites still apply.
- Code: `runtime/`, `startup.ts`, `effects.ts` configuration functions, `profiles.ts` I/O, pure step result integration, and application-facing callers/tests.
- Reuse `bun:sqlite` and current canonical path/schema/digest rules. No new persistence package is required.
- Followed by `migrate-workflow-execution-to-effect` and `complete-workflow-effect-cutover`.

## Non-goals

No `@effect/workflow`, cluster runtime, new database, new authorization model, graph changes, speculative service per helper, or external CLI protocol redesign. Pure functions need not become Effect programs.
