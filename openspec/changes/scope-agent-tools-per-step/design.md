## Context

`installWorkflowExtensions` installs dialogue, judgment, search, environment, browser, debug, stage and debug-request extensions for every workflow run; `toolSelectionFor` only narrows read-only runs (no `write`/`edit`) and debug runs (no `debug_*` request tools). `pi-durable` is the only adapter. The `slim-agent-prompts` inventory measures the tool descriptions at ~26 KB per request.

## Goals / Non-Goals

**Goals:** install per run only the tool groups its step declares; trim the longest descriptions; keep every refusal the server enforces.

**Non-Goals:** no change to server-side enforcement, step ids, roles, schemas or the store.

## Decisions

- Tool groups are declared in step behavior (`steps/`), defaulting to every group for a step without a declaration (fail-open for custom steps).
- Proposed groups per family: planning/wiki/research/archive/rebase — dialogue, judgment, search, evidence; implementation — all but stage; verifiers — all but stage, browser only for usability; debug — environment, browser, debug tools, evidence; env-setup — environment, debug tools; stage roles — dialogue, stage, browser (stage-bound), evidence.
- Description trims keep each tool's contract (inputs, refusals, bounds) and drop examples the tool's answers already explain.

## Risks / Trade-offs

- [A role legitimately needs a tool its step no longer installs] → fail-open default for undeclared steps; groups are one declaration per step; manual runs per family before landing.

## Open Questions

- Should verifiers keep the browser group (usability-verifier only) or should UI checks be delegated through `debug_request`?
