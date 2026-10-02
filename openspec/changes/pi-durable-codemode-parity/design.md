## Context

pi-codemode runs sandboxed JavaScript whose only capability is calling injected tools; it ships a WASM runtime that must be embedded by `bun build --compile`.

## Goals / Non-Goals

**Goals:** parity with managed pi tool inheritance for `codemode` and `tool_search`.

**Non-Goals:** loading arbitrary user pi extensions.

## Decisions

- Inject only the conversation's offered tools into the codemode sandbox, so read-only runs cannot reach edit/write.
- Resolve enablement from the global pi `defaultTools` with pi's `+/-` rules, as `pi-tools.ts` does today.
- Embed WASM assets with static file imports (the compiled binary does not preserve node_modules resolution).

## Risks / Trade-offs

- [WASM asset embedding fails in the compiled binary] → compile smoke test; tool reports unavailable instead of failing the run.
