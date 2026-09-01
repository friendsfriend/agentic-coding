## Context

See `proposal.md` - Why. Today `core.research` only allows the researcher's run to end with `blocked` or `failed` (`createRun` hardcodes `allowedOutcomes = ["blocked", "failed"]` for this role/step), so the run's own output path can never legitimately carry real findings. `request-research-wiki` (in `agentic-coding/src/workflow/runtime.ts`) reads that path anyway, in a best-effort `try/catch`, size-capped at 64KB, and falls back to nothing if it's missing or unparsable — which is the normal case. The wiki role otherwise only receives `task` and the last 50 raw follow-up strings (`snapshot.step.context.followUps`). Ordinary follow-up Q&A already has a working pattern for mutating step state without ending the interactive session: the `research-follow-up` action appends to `snapshot.step.context.followUps` and prompts the same live run, with no transition and no new run generation. Persistent-role transitions (the `blocked`/`failed` self-loops) do end the current run generation and relaunch a new one reusing the terminal/session — appropriate for recoverable errors, but disruptive if triggered just to record a checkpoint document.

## Goals / Non-Goals

**Goals:**
- Give the researcher a way to record a structured handoff while remaining interactively active, with no transition or run-generation change.
- Make `request-research-wiki` require and validate that handoff before it does anything else, replacing the current best-effort optional read.
- Make the full handoff content, not a truncated transcript, the primary context the wiki role receives.

**Non-Goals:**
- Changing who may dispatch `request-research-wiki` or `close-research` — these remain developer-authenticated actions; the researcher still cannot self-transition into `core.wiki`.
- Changing OKF wiki authoring conventions, `wiki write` semantics, or `core.wiki-approval` review behavior.
- Versioning or diffing multiple handoff revisions — the latest recorded handoff for the active research run is authoritative.
- Any change to standalone-vs-repository-context research startup, source-isolation validation, or the read-only researcher boundary.

## Decisions

- **Record via a run-scoped action, not a new self-loop workflow outcome.** Add an authenticated action (analogous to `research-follow-up`, but restricted to the active `core.research` researcher run rather than the developer) that validates and stores the handoff into `snapshot.step.context.handoff`, then returns without transitioning the step or ending the run.
  - *Alternative considered:* add a new step outcome (e.g. `research-handoff`) reusing the existing `agentic-coding workflow handoff` self-loop machinery already used for `blocked`/`failed`. Rejected: that machinery always ends the current run generation and relaunches the persistent session to deliver the next prompt, which would interrupt the ongoing interactive conversation and is unnecessary churn for what is conceptually a mid-conversation checkpoint, not an error recovery.
- **Validate against a dedicated handoff contract**, not the generic `core.json` passthrough currently used for `core.research` output. Require a non-empty subject and either at least one source citation or an explicit statement that no external sources were used, with optional canonical-target and outline/findings fields — following the existing pattern of dedicated contracts like `core.findings` rather than accepting arbitrary JSON.
  - *Alternative considered:* keep accepting arbitrary JSON and only check "some object exists". Rejected: this is exactly today's failure mode (the wiki role gets an unpredictable shape or nothing) and would not meaningfully fix the reported problem.
- **Gate `request-research-wiki` on the recorded handoff before any other effect.** Validate `snapshot.step.context.handoff` first and throw an actionable `WorkflowRuntimeError` when it is missing or invalid, before touching `validateSourceBaseline`, workspace checks, or run lookup. Only after that check passes does the existing expire/stop/transition sequence run.
- **Allow re-recording.** Each call to the record action overwrites the previously recorded handoff for the active run, so the researcher can revise it during the same interactive session without a strict one-shot requirement.
- **Wiki assignment uses the recorded handoff verbatim** (subject, canonical target, outline/findings, citations) alongside the existing `task` and repository context, replacing the current size-capped optional `summary` field.

## Risks / Trade-offs

- [Researcher forgets to record a handoff, and `request-research-wiki` starts failing where it used to silently proceed] → Mitigate with a clear, actionable rejection message and updated `research.md` instructions that make recording the handoff the explicit first step once a wiki entry is requested, before telling the developer the action is available.
- [Extra required step adds a small round-trip before wiki drafting can start] → Keep the handoff schema minimal (subject, findings/outline, citations; canonical target optional) so recording it is a single, low-friction tool call.
- [Existing/in-flight research runs from before this change never call the new record action] → No persisted-data migration is needed since this only gates a developer-dispatched action; an in-flight session simply needs the researcher to record a handoff once, using the updated instructions, before `request-research-wiki` will succeed.

## Migration Plan

No data migration. This only changes in-process validation and role instructions gated behind the existing `request-research-wiki` developer action; it ships as a normal workflow-engine change following the project's existing step/definition versioning.
