# Design

## Context

The start route decodes `WorkflowStartRequest` (strict, excess properties
rejected) and calls `startWorkflowInProcess`, which maps a `workflowType` to a
built-in definition id. The orchestrator principal is confined to an exact route
allowlist. The compiler is pure; storage happens in `initializeStore`-owned
mutating paths.

## Goals / Non-Goals

**Goals:**

- The session never sends a manifest; the server compiles every blueprint itself.
- One start path for built-in and blueprint workflows after compilation.
- The developer can see why a custom shape was chosen.

**Non-Goals:**

- Dashboard presentation of custom graphs (`show-custom-workflow-graph`).
- Blueprint editing by the developer in the TUI.
- Blueprints for wiki/research targets.

## Decisions

- **Blueprint in the start request, not a two-step define/start.** A stored but
  unstarted definition has no workflow to own it; compiling and storing inside the
  start operation keeps definition and workflow in one target store and one
  mutation. Validation is a separate, side-effect-free route.
- **Mutually exclusive with `workflowType`.** The schema is a union; both or
  neither is a 400.
- **Same rules for both principals.** The compiler's human-review invariant
  applies to every blueprint, so an operator cannot accidentally author a
  review-free blueprint either; operators who need one use `workflow define`.
- **Origin and rationale pinned.** `metadata.blueprint` and the definition's
  `origin_json` (principal, time) make the custom shape auditable.
- **Bounded catalog response.** The step catalog is small and static per binary;
  it is served from the compiler's catalog, not the registry dump.

## Risks / Trade-offs

- [Models over-use blueprints] → The prompt prefers built-in types and requires a
  rationale; the developer sees it in every review anyway.
- [Start fails after storing the definition] → Storing is idempotent by digest;
  a retried start reuses the stored definition.
