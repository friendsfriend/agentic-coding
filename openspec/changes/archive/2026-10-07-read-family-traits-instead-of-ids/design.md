# Design

## Context

Behavior hooks are pure and receive `{ snapshot, definitionId, … }`; the
snapshot holds only the definition pin, not the manifest. The runtime resolves
the compiled definition for every command, so it can resolve traits once and
pass them in. Start-boundary code (`startup.ts`, `startArgs`) runs before a
snapshot exists and has the definition id plus the registry.

## Goals / Non-Goals

**Goals:**

- No repository code-change family id branch left outside `definitions/`.
- Byte-identical behavior for every built-in family at every tier.

**Non-Goals:**

- Wiki, research and wiki-comments id checks (documentation families keep them).
- Any new trait or behavior.

## Decisions

- **Traits in hook inputs, not a lookup.** Hooks stay pure and import nothing
  from definitions; the runtime passes `traits` (possibly `undefined` for
  documentation families). Behavior is excluded from digests, so changing hook
  inputs needs no new tier.
- **Start boundary resolves the definition first.** `startArgs` and
  `validateStart` resolve the target definition (newest tier) and read
  `policy.checkoutRequired` and traits, instead of their id lists.
- **Migrate per area, keep suites green between steps.** Steps first (pure,
  well-tested), then runtime, then start boundary and effects. Each area is one
  task with its focused suites.
- **Guard last.** The architecture test lands with the final task so it proves
  the inventory is fully drained.

## Risks / Trade-offs

- [A subtle branch combines a family id with a step id] → The inventory from the
  traits change lists each with its decision; review each conversion against it.
- [Legacy tiers lose behavior] → Effective traits come from the fallback table for
  every pinned tier; the parity test from the traits change covers it.
