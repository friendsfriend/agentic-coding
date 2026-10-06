# Design

## Context

`app.ts` already knows the principal of every request and passes
`enforceHumanReviewGates` to starts as a server-decided option. Developer actions
reach `developerAction`, which records `actor: { kind: "developer" }`.
`ActorKind` (`agent | developer | system`) also types step actors, so it is not
the right place for a principal.

## Goals / Non-Goals

**Goals:**

- Durable, queryable "who started this" on every new workflow.
- Event history that distinguishes orchestrator actions.

**Non-Goals:**

- Attributing agent handoffs or system effects (unchanged).
- Changing `ActorKind` or any step actor.

## Decisions

- **`principal` beside `kind`.** Event actors gain an optional `principal`
  field instead of a new `ActorKind`, so step definitions, digests and existing
  event readers are untouched.
- **Pinned at start.** `startedBy` is metadata pinned once, like
  `gatePolicies`; it never changes and is not affected by later actions.
- **Additive schema.** `startedBy` is optional in the snapshot schema and
  defaulted on read, so stores need no migration. Whether an older binary
  tolerates the unknown field depends on its decoder; rollback across this
  change is therefore not guaranteed and is called out in the risks.
- **One option object.** The existing `StartOptions` grows `principal`; a new
  `ActionOptions { principal }` is passed to `action`. Both default to the
  operator.

## Risks / Trade-offs

- [Snapshot decoders reject unknown fields] → Add the optional field to the
  schema in the same change; a test decodes a snapshot with and without it.
