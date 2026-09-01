## Why

Research currently rejects user-configured tool names outside a hard-coded read-only list and removes configured Pi extensions, preventing researchers from using user-provided web search and other research integrations. The research runtime should honor the user's selected tool and extension configuration while making the trust-boundary change explicit.

## What Changes

- Allow a researcher's selected profile to expose arbitrary user-configured tool names instead of applying the built-in read-only tool-name allowlist.
- Preserve and launch the selected profile's configured Pi extensions, including extensions that provide user-defined research tools.
- Keep the existing research workflow lifecycle, runtime capability checks, and research instructions; document that custom tools and extensions are user-trusted and may not be enforceably repository-safe.
- Update focused research routing, startup-guard, adapter, and runtime tests to verify configured tools and extensions are retained and launched.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `research-workflow`: research must permit all tools and extensions explicitly configured on the selected user profile, rather than restricting the researcher to the built-in read-only tool allowlist.

## Impact

- `agentic-coding/src/workflow/profiles.ts` and `agentic-coding/src/workflow/runtime.ts`: research profile normalization and startup validation.
- `agentic-coding/src/workflow/adapters.ts`: research launch behavior for configured extensions and runtime tool policies.
- `agentic-coding/src/workflow/assignment.ts` or embedded research instructions: communicate the user-trusted custom-tool boundary if needed.
- Focused workflow profile, runtime, adapter, and research-effect tests; the generated embedded asset must be regenerated if source instructions change.
