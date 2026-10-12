# Design

## Context

A developer question is a durable `developerDialogue` record owned by the
engine. Creation authenticates the active run capability
(`reducers/agent-question.ts`), answering flips the record
(`runtime/dialogue.ts`), and the requester learns the outcome only because the
`agentic-coding workflow question` process it spawned keeps polling the store
until the record leaves `pending`.

That single delivery path is what breaks:

- The durable tool (`agent-host/tools.ts`) spawns the CLI and awaits it. The CLI
  default wait is `QUESTION_WAIT_MS` = 24 h (`runtime/dialogue.ts`).
- pi-durable places a developer's in-session message as a `steer` input only at
  the `postTools` boundary (`harness/generation.js:502`,
  `harness/submissions.js:149`), which a blocking tool prevents — so typing an
  answer in the agent session can never reach the question.
- pi-durable aborts a running generation to settle an explicit abort, which
  settles the tool task as `aborted` (harness `tool.js` `abort`) and leaves the
  engine's run `working` with its question `pending`.
- `answerQuestion` (`runtime/dialogue.ts`) only rewrites the record; nothing
  re-issues or wakes the run, so an answer delivered after the tool process is
  gone is never consumed.
- For an orchestrator-started workflow the record carries
  `targetRole: "orchestrator"`, which `pendingDeveloperQuestions`
  (`runtime/view.ts`) filters out, so the developer's modal never shows it.

The engine already has the two mechanisms this design needs: `blocked` is an
allowed handoff outcome that parks the workflow in `attention-required`
(`reducers/agent-handoff.ts`), and every rendered assignment already carries all
non-pending dialogue as `## Prior dialogue (untrusted context)`
(`effect-runner.ts`).

## Goals / Non-Goals

**Goals:**

- A question never holds a model turn open for longer than a bounded grace.
- An answer always reaches the run that asked, whether it arrives in the grace
  window or hours later.
- A workflow that is waiting on an answer is visibly parked in
  `attention-required` with the pending question as its reason, never silently
  `working`.
- An idle orchestrator session cannot strand an orchestrator-started workflow.
- A developer abort of a run cannot leave the run `working` indefinitely.
- No schema change, no new effect kind, no scheduler.

**Non-Goals:**

- Not changing the 24 h durable expiry, the dialogue bounds, the questionnaire
  format, or the peer-question delivery prompt.
- Not building a durable timer/effect for question expiry; the existing
  drain-time `dueQuestionTimers` backstop stays as it is.
- Not redesigning the question modal beyond showing orchestrator-routed pending
  questions.
- Not re-running sibling runs of the same step: only the run that asked is
  re-issued.

## Decisions

### D1 — The tool wait is a bounded grace, not the question lifetime

`AGENT_QUESTION_WAIT_MS = 120_000` is the default wait for the agent-facing
`workflow question` and `workflow ask` commands (overridable with `--timeout`).
When the window elapses with the record still `pending`, the CLI prints the
pending record and exits 0; the question keeps its 24 h durable expiry.

Alternatives:

- *Return immediately with no wait*: every question costs a handoff plus a new
  run even when the developer is sitting at the modal. The grace keeps the
  interactive case a single turn while still bounding the blocking case.
- *Keep 24 h*: the deadlock and the stuck run, by construction.
- *Block with an in-session interrupt hook*: needs a pi-durable hook that
  cancels a running tool from the inbox, which the harness does not offer.

### D2 — Deliver the answer by re-issuing the asking run

`resumeBlockedAsker` (in `runtime/kernel.ts`, which owns `createRun` and
`enterStep`) runs after an answered dialogue record commits:

Preconditions — the workflow is `attention-required`, the question's step is the
current step, no run for the question's role is active, the question's
`runId` is in `completedRunIds`, and that run row is `blocked`.

Effect — `snapshot.step.attempt += 1`, `createRun(db, snapshot, step,
question.role, now)`, then clear `attention` and set `status = "active"` unless
another run row is still `blocked` (a second parked run keeps the workflow in
`attention-required`). The new run is launched through the usual
`artifact.write`/`agent.launch` effects, and its assignment carries the answer in
the existing prior-dialogue section.

Only the asking role is re-issued, so a sibling verifier that already completed
is not re-run; `enterStep` would re-run every role of the step, which is wrong
for multi-run verification steps.

Alternatives:

- *Re-enter the step with `enterStep`* (as `repair`/`resume` do): re-runs sibling
  roles and resets step results/context.
- *Add a `waiting` run status and resume the same run*: a store/status change
  with a much wider blast radius for the same visible behavior.
- *Deliver the answer into the live conversation as a follow-up input*: needs a
  converse/steer path from the engine into a pi-durable conversation, which the
  host owns and the engine cannot reach through the engine/transport boundary.

### D3 — The resume trigger is the engine's answer reducers

`developer-action.ts` (developer and orchestrator answers) and
`agent-consult.ts`'s `agentAnswer` (peer answers) call the resume after an
`answered` outcome. `agentAnswer` gains the definition/registry parameters the
engine already holds. Cancellation, expiry, and forwarding do not resume: a
parked workflow stays `attention-required` for the developer to repair, retry,
or answer.

### D4 — Orchestrator routing keeps first refusal; the developer is the backstop

An orchestrator-routed record still carries `targetRole: "orchestrator"`, the
orchestrator answers or forwards it exactly as today, and the 24 h backstop is
unchanged. Two things change so the backstop is not the only way out:

- `pendingDeveloperQuestions` also returns orchestrator-routed pending records,
  so the developer's modal and the sidebar's `?` glyph show a parked workflow's
  waiting question.
- `answerQuestion`'s operator guard accepts an orchestrator-routed record and
  clears its marker when the developer answers it. The orchestrator guard is
  unchanged: the orchestrator still may only answer records routed to it.

Alternative: a shorter auto-forward window. It would need a reliable scheduled
drain; the drain-time `dueQuestionTimers` path only fires while a drain is
running, and no new timer effect is in scope (Non-Goals).

### D5 — A developer abort is recorded as a `blocked` handoff

`DurableHost.abort(runId)` already aborts the conversation. It now also spawns
the run's own `agentic-coding workflow handoff --outcome blocked --no-drain
--message "aborted by the developer"` with the run environment it launched the
run with, when that environment carries a run identity. Best-effort: a failure
(a run that already handed off) is logged and ignored. `stopRun` (workflow
teardown) does not hand off.

This closes the general lost-turn hole: an abort mid-run parks the workflow at
`attention-required` instead of leaving a `working` run whose turn is gone.

### D6 — The durable tools forward their abort signal

`developer_question`/`agent_ask` pass the tool context's abort signal into
`runWorkflowCli`, matching the pi extension that already kills the child. An
aborted call kills the CLI instead of leaving a 24 h long-poll behind. The
question stays `pending`; D5's blocked handoff parks the run, and D2 resumes it
when the answer arrives.

## Risks / Trade-offs

- [A second answer or a replayed action re-issues twice] → the resume guard
  requires the asker run to still be `blocked` and no active run for its role;
  the first re-issue makes both false.
- [An answer arrives after the workflow moved on] → the guard requires the
  question's step to be the current step and the workflow to be parked; a moved
  workflow is untouched.
- [The developer answering an orchestrator-routed question weakens "orchestrator
  first"] → only pending records are answerable and only the developer's
  operator path is widened; the orchestrator's guard is unchanged and documented
  behavior for its own path is identical.
- [120 s of grace delays parking] → bounded by design; the agent still parks with
  a visible question instead of blocking a day.
- [Host abort handoff spawn fails or races the engine] → best-effort, logged,
  `--no-drain`, and idempotent by construction (the engine rejects a handoff for
  a run that is not pending/working).
- [Instruction asset change] → instruction digests are presentation pins and do
  not enter the step or definition digest (`registry.ts` `stepDigest`), so no
  pinned workflow breaks; the embedded asset must be regenerated with
  `bun run build`.
- [Existing stuck workflows] → pre-existing pending questions belong to runs that
  are still `working`, so answering them will not re-issue. Rollout must repair
  or retry those runs once; the change does not migrate them.

## Migration Plan

1. Land the engine, CLI, tool, host, and prompt changes together; instruction
   assets are regenerated as part of the build.
2. Rollback is a code revert: no store migration, no definition version bump, and
   a reverted build re-reads existing snapshots unchanged. Any run re-issued by
   the change is an ordinary run.
3. Operator step after rollout: for a workflow already stuck before this change,
   use the dashboard repair/retry path once; new questions park and resume
   without intervention.

## Open Questions

- Should a *cancelled* question also re-issue the asking run (letting the agent
  decide with a recorded cancellation) instead of leaving the step parked for a
  manual repair? Deferred: it can loop ask→cancel at one question per 24 h, so it
  needs a bounded retry rule first.
