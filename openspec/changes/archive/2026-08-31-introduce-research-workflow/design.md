## Context

The built-in registry currently models finite agent steps and developer/system terminal steps. Agent completion is run-bound and generic, while long-lived follow-up interaction is represented only by adapter capabilities such as `persistent-session`; an agent settling without a handoff does not advance a workflow. Wiki writes are authenticated specifically for `core.wiki`/`wiki`, and the CLI currently assumes every start has a repository, change ID, and mode.

This change introduces a repository-optional research lifecycle. A research request may be independent of source code or may provide a repository as read-only context. The researcher needs to remain available for user follow-ups, and only an explicit wiki request hands the accumulated research to the wiki drafting and developer approval stages. The workflow can still be directly closed before that handoff.

## Goals / Non-Goals

**Goals:**

- Add a pinned, selectable `research` workflow with the successful path `core.research → core.wiki → core.wiki-approval → core.closed`.
- Route the step to a dedicated `researcher` role with a persistent, interactive session and trusted research instructions.
- Accept standalone requests and optional repository context, keeping any supplied repository read-only.
- Preserve follow-up dialogue and route subsequent prompts to the same live researcher before explicit closure.
- Permit an explicitly requested wiki draft through the dedicated `core.wiki` stage, followed by developer approval through `core.wiki-approval`, using centralized OKF conventions without granting agents human verification privileges.
- Add a developer-only `close-research` action that directly expires/stops active researcher runs and transitions to `core.closed`, so closure works even if the runtime is unavailable.
- Expose the workflow and action consistently in CLI, routing, dashboard views, and focused tests.

**Non-Goals:**

- No new web-search provider, browser integration, or dependency; the researcher uses tools exposed by its selected runtime/profile.
- No mandatory repository, branch, worktree, OpenSpec change, implementation, verification, delivery, archive, or pull-request lifecycle.
- No implementation, review, delivery, archive, or pull-request stage in the research graph; wiki drafting and approval are intentionally included.
- No automatic wiki write based on a research answer, and no automatic workflow completion based on agent settlement.
- No durable research report artifact requirement; the workflow's persisted context/dialogue and centralized wiki draft (when requested) are the durable outputs.

## Decisions

### 1. Use a dedicated registered research step and explicit research/wiki graph

Register `core.research` as an agent step with its own `research.md` instruction asset and persistent researcher capabilities. Register a versioned `research` manifest containing `core.research`, `core.wiki`, `core.wiki-approval`, and `core.closed`, with `core.research` as initial and `core.closed` as terminal. The developer-only `request-research-wiki` action is the engine-recorded transition into the dedicated wiki drafting stage after the user requests an entry; the researcher cannot self-submit completion.

This preserves the registry's explicit graph and pinning model while reusing the existing wiki drafting and approval controls. The graph excludes implementation, review, delivery, archive, and pull-request steps.


### 2. Keep the research run alive until the developer closes it

Use the existing persistent-session routing and prompt transport. A researcher may answer repeatedly without handing off; runtime settlement and output-file presence do not complete the step. Follow-up prompts are delivered to the active run/session through the existing generic prompt action path. If the user requests a wiki entry, the developer dispatches `request-research-wiki`, which expires the researcher run and starts `core.wiki`; otherwise only bounded `blocked` or `failed` handoffs are allowed.

The `close-research` developer action is an explicit exception to the normal agent-step transition: the reducer expires active research runs, queues the existing stop effect where a handle exists, and transitions directly to `core.closed`. This direct close was chosen over handoff-gated closure because the user explicitly needs to close at any time and a dead runtime must not prevent closure.

### 3. Support an optional repository without making the workflow repository-backed

Extend start parsing and validation so `research` may omit `--repo` and run against the workflow's repository-independent data target, while accepting `--repo PATH` as read-only evidence context. Do not create a branch/worktree or require `--mode`, OpenSpec, a clean tree, or a named branch for this definition. Store empty repository/branch/base fields when standalone; when a repository is supplied, retain its path and task context but grant only read permissions to the researcher.

The repository-independent path follows the existing canonical workflow-store/data-root mechanism rather than inventing a second persistence system. The implementation must ensure that optional repository context cannot become a source mutation or a requirement for startup.

### 4. Treat wiki drafting as an authenticated reviewed stage

Extend wiki authorization for the authenticated `core.wiki`/`wiki` run of a research workflow, binding writes to the active run capability, pinned centralized wiki root, and current workflow. The researcher instruction requires an explicit user request before handing off to wiki. The wiki instruction performs update-first search/show behavior, uses project-aware concept paths, includes source URLs or concrete citations, writes draft status, and cannot grant human verification. `core.wiki-approval` supplies the developer approval gate, while existing archive/human promotion safeguards remain unchanged.

The research graph reuses the existing wiki drafting and approval stages rather than giving the researcher direct wiki-write permission. The implementation should reuse `writeConcept` and existing snapshot/provenance handling rather than creating a research-specific wiki format.

### 5. Keep web access runtime-neutral and evidence-oriented

The researcher instruction will require it to use only tools available through the selected runtime/profile, without naming a mandatory browser or MCP integration. It must identify sources, cite URLs where web evidence is used, distinguish sourced facts from synthesis, and state uncertainty or conflicting evidence. Profile capabilities/tools remain the operator's extension point.

Mandating a specific browser or provider was rejected because operators may install custom tools for the harness and the workflow must remain adapter-independent.

### 6. Reuse workflow state dialogue and routing structures

Pass the initial task and optional repository context through existing workflow metadata/step context, preserve answered developer dialogue in assignment context, and route all subsequent researcher prompts with the same run identity. Add only the minimum state/action handling needed for `close-research`; do not add a transcript database or a second session model. The dashboard should render the researcher step, active run, follow-up prompt affordance, and close action using existing view/action contracts.

## Risks / Trade-offs

- **[Persistent runtime can disappear while research remains active]** → Keep the workflow active until explicit close, expose attention/recovery for failed runs, and make `close-research` direct and idempotency-safe.
- **[Researcher may start documentation without a sufficiently explicit request]** → Require the developer-only `request-research-wiki` action before entering `core.wiki`, enforce authenticated wiki-role/root scope in the CLI, and retain draft-only/human-promotion safeguards.
- **[Standalone store and optional repository paths may diverge]** → Reuse the existing repository-independent workflow target/data-root resolution and test both start modes with the same registry pinning rules.
- **[Persistent sessions differ across Pi/OpenCode adapters]** → Require the step capability contract at preflight and keep lifecycle semantics in the registry/runtime rather than embedding them in one adapter.
- **[No report artifact means research is not independently exportable]** → Preserve the workflow's task, research handoff context, developer dialogue, and evidence metadata; defer a dedicated export format unless a later requirement establishes one.

## Migration Plan

Register the new definition alongside existing definitions; no existing workflow pin or persisted row changes. Add compatibility handling only for newly recognized `research` starts and snapshots. Existing workflows retain their current action and wiki authorization behavior. Rollback consists of removing the new selectable definition/step after any active research workflows are closed or repaired; do not reinterpret existing definition pins.

## Open Questions

- The exact dashboard prompt interaction for sending follow-ups to a persistent researcher should reuse the current agent prompt affordance, but its final visual label and placement should be confirmed during implementation against the current dashboard conventions.
- The researcher reports the explicit wiki request in its persistent session; the developer-only `request-research-wiki` action starts the dedicated wiki stage, which writes a draft and the developer approval stage controls promotion.
