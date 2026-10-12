# Proposal

## Why

A managed agent that needs a decision keeps its `developer_question`/`agent_ask`
call blocked until someone answers, and in the durable runtime that blocked call
is the *only* answer-delivery channel. Nothing else can free it: a developer chat
message is queued as `steer` and only placed at the post-tools boundary the
blocked call prevents; an abort settles the tool as aborted but leaves the
engine's question `pending` and the run `working`; and in an orchestrator-started
workflow the question is routed to the orchestrator, which only acts when the
developer prompts it, so the developer sees no pending input at all.

Observed on 2026-10-12: two workflows were left stuck this way — runs
`a6f31ca2` (`add-workflow-cycle-keybinds-2`) and `ca4cc2ae`
(`add-dashboard-evidence-panel`), both parked at `core.implementation` with an
aborted `developer_question` tool result in the run transcript and questions
`867256c8` / `259014ef` still `pending`, routed to the orchestrator, invisible in
the developer's pending set, and 24 hours away from the only backstop.

## What Changes

- `developer_question` and `agent_ask` wait only a bounded agent grace window and
  then return a `pending` result; the question stays pending in the engine
  instead of the tool call holding the turn for up to 24 hours.
- An agent whose question comes back `pending` reports a `blocked` handoff naming
  the question; the workflow parks in `attention-required` with the question
  visible as the reason.
- When a parked run's question is answered, the engine re-issues that run for a
  new attempt, and the answer reaches it through the assignment's existing
  "Prior dialogue" section. The tool call is no longer the delivery channel.
- A question routed to the orchestrator stays the orchestrator's first, but a
  pending orchestrator-routed question is also answerable by the developer, so an
  idle orchestrator session cannot strand the workflow.
- A developer-initiated abort of a run is recorded as that run's `blocked`
  handoff, so an interrupted turn parks the workflow instead of leaving it
  awaiting a turn that will never arrive.
- The durable dialogue tools forward their abort signal to the spawned question
  CLI, so an aborted call cannot leave an orphaned long-poll.

## Capabilities

### New Capabilities

<!-- None: this change corrects existing dialogue behavior. -->

### Modified Capabilities

- `workflow-developer-question`: the invocation's wait becomes a bounded grace
  that may return a `pending` result, and an answered question resumes the
  blocked asking run on a new attempt.
- `durable-agent-tools`: the dialogue tools bound their wait, return `pending`,
  and forward their abort signal.
- `home-orchestrator`: developer questions raised by orchestrator-started
  workflows are routed to the orchestrator first, are visible while parked, and
  remain answerable by the developer as the backstop.
- `herdr-workflow-prompting`: the role prompt tells an agent to hand off
  `blocked` with the pending question and to read the answer from prior dialogue
  on the resumed attempt.
- `workflow-agent-assignment`: a developer-aborted run is recorded as a `blocked`
  handoff rather than left awaiting a dead turn.

## Impact

- `agentic-coding/src/workflow/runtime/dialogue.ts` — agent grace constant, the
  operator may answer an orchestrator-routed question.
- `agentic-coding/src/workflow/runtime/kernel.ts` — re-issue the blocked asking
  run on answer.
- `agentic-coding/src/workflow/runtime/reducers/developer-action.ts`,
  `runtime/reducers/agent-consult.ts`, `runtime/engine.ts` — call the resume on
  an answered question (developer, orchestrator, and peer answer paths).
- `agentic-coding/src/workflow/runtime/view.ts` — pending developer questions
  include orchestrator-routed ones.
- `agentic-coding/src/workflow/cli/commands/dispatch-actions.ts` — the agent wait
  defaults to the grace and returns `pending` without expiring.
- `agentic-coding/src/agent-host/tools.ts` — bounded wait, forwarded abort
  signal, tool guidance.
- `agentic-coding/src/agent-host/host.ts` — record a developer abort as a
  `blocked` handoff.
- `agent-definitions/instructions/workflow-agent-protocol.md` plus the
  regenerated embedded asset — the agent's `pending` → `blocked` rule.
- `agentic-coding/test/workflow-question.test.ts` and the focused agent-host
  suites.
- No store schema change, no new effect kind, no definition/step semantic pin
  change (instruction assets are presentation pins).
