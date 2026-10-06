# Proposal

## Why

With custom definitions storable and blueprints compilable, the orchestrator
still has no way to use them: its tools can only start a built-in workflow type.
This change connects the pieces so the orchestrator can describe a workflow that
fits the request, see the compiler's verdict, and start it — with the server, not
the session, compiling, storing and enforcing the human-review rules.

## What Changes

- Server routes:
  - `GET /api/v1/workflow/steps` returns the blueprint step catalog.
  - `POST /api/v1/workflow/blueprint/validate` compiles a blueprint without side
    effects and returns the summary (steps, edges, inserted routing/gates),
    digest and diagnostics.
  - `POST /api/v1/workflow/start` accepts `blueprint` as an alternative to
    `workflowType` (exactly one): the server compiles it, stores the definition
    in the target store with origin `blueprint` and the principal, pins
    `metadata.blueprint = { label, rationale, digest }`, and starts it.
- Orchestrator policy allows the two new routes; orchestrator blueprint starts
  keep the human-review gate pin and the launch limits.
- Orchestrator tools: `list_steps`, `validate_blueprint`, and a `blueprint`
  parameter on `start_workflow`. The prompt tells the orchestrator to prefer a
  built-in type, to validate before starting, and to state the rationale to the
  developer.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `home-orchestrator`: blueprint tools and routes in the orchestrator boundary.
- `workflow-blueprints`: server-side validation and start of blueprints.

## Impact

- `src/contracts/actions.ts` (start request union, validate request),
  `src/server/protocol.ts` (route manifest), `src/server/app.ts`,
  `src/server/handlers.ts`, `src/server/operations/engine.ts`,
  `src/server/orchestrator-policy.ts`.
- `src/workflow/startup.ts` (start from a stored custom definition),
  `WorkflowMetadata.blueprint`.
- `src/agent-host/orchestrator.ts` (tools, prompt).
- `docs/orchestrator.md`, `docs/unified-backend-api.md` (route table).
- Depends on `persist-custom-workflow-definitions`,
  `add-workflow-blueprint-compiler`, `attribute-orchestrator-actions`
  (origin principal) and `cap-orchestrator-launches`.
