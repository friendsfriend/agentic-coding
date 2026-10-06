# Proposal

## Why

The orchestrator should be able to shape a workflow to the request — for example
"implement, verify, developer review, deliver" without planning or wiki, or a
fusion plan that stops at approval — instead of picking the nearest built-in
family. Hand-writing a full manifest is not something a model can do safely: the
newest tier inserts routing steps before every classifiable step, the triage
routing step and stage gates in exact places, pins exact step references, and
must never lose a human review. That construction must be code, not prompt.

## What Changes

- A **workflow blueprint**: a small logical description of a workflow — label,
  rationale, family traits, checkout requirement, the logical steps, their
  edges and loop bounds, and the verification round count.
- A pure **blueprint compiler** (domain layer) that turns a blueprint into a
  manifest satisfying the custom-definition invariants: it rejects internal steps
  (routing, triage routing, gates), inserts them the same way the newest built-in
  tier does, pins exact step references, derives the policy from the traits, and
  dry-compiles the result with the registry's validation.
- A **human-review validator** on the logical graph: implementation work cannot
  reach delivery, completion, archive or wiki without a developer or findings
  review; a plan cannot reach implementation without plan approval; wiki work
  cannot reach archive, delivery or completion without wiki approval.
- Bounds: step count, loop attempts and round count within the built-in ranges.
- A **blueprint step catalog** describing the steps a blueprint may use (id,
  label, actor, outcomes, what it does) for tools and documentation.
- Deterministic output: the same blueprint compiles to the same digest.

## Capabilities

### New Capabilities

- `workflow-blueprints`: blueprint schema, step catalog, compilation and the
  human-review invariant.

### Modified Capabilities

None.

## Impact

- New `agentic-coding/src/workflow/blueprints/` (domain: schema, catalog,
  compiler, review validator), reusing `definitions/edges.ts`
  (`withPerStepRouting`), `definitions/steps.ts` (`exactStepReferences`) and the
  registry's `compileWorkflow`.
- `src/workflow/schema.ts` (Effect Schema for the blueprint).
- `docs/workflow-architecture.md` (blueprint section).
- Depends on `add-definition-family-traits` and the `compileWorkflow` split from
  `persist-custom-workflow-definitions`. No I/O, no server or tool changes.
