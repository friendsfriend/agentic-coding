## ADDED Requirements

### Requirement: Checkpoint thresholds are per role class and never stop a run

The durable agent host SHALL evaluate a run-progress checkpoint for every
supervised run that has a run id, and for no session without one. A run's
checkpoint class SHALL be declared by its registered step behavior (`worker`,
`planner`, `verifier`, `mechanical`) and passed to the host in the run
environment; an undeclared class SHALL be `other` and use the worker values.
The first checkpoint SHALL fire when the run's turn count reaches the class's
soft threshold or its measured context reaches the configured context
threshold, and later checkpoints SHALL fire every `max(10, softTurns / 2)`
turns after it. From turn 30, a stall signal (failing tool, exact repeats, no
progress, cost rising, context) SHALL also fire a checkpoint, at most once per
interval. Reaching a soft threshold, the hard limit, a context size or a cost
SHALL NOT by itself stop, abort, block or hand off a run; only a decision
applied as specified in this capability may change what the run does.

The shipped defaults SHALL be pinned from the measured distribution by this
formula: `softTurns` is the p90 of the class's runs with turns, rounded up to
10; `hardTurns` is `max(5 × softTurns, 1.2 × successful p99, 1.2 × all-runs
p99)`, rounded up to 50; the context threshold is 200,000 tokens.

#### Scenario: A run reaches its soft threshold

- **WHEN** a worker run with the default configuration finishes its 250th turn
- **THEN** the host SHALL evaluate one checkpoint for that run
- **AND** the run SHALL keep running unless that checkpoint's decision changes it

#### Scenario: A run without a run id

- **WHEN** a durable session has no `HERDR_RUN_ID` (the orchestrator)
- **THEN** no checkpoint SHALL be evaluated for it

#### Scenario: Hard limit reached

- **WHEN** a run reaches its class's hard limit
- **THEN** the checkpoint SHALL decide `escalate`
- **AND** the run SHALL NOT be stopped unless the escalation's developer question was recorded

#### Scenario: Class declared by the step

- **WHEN** a verifier step starts a run
- **THEN** the run environment SHALL carry the `verifier` checkpoint class from the step's registered behavior
- **AND** the host SHALL NOT derive the class from a role table of its own

### Requirement: The decider sees a content-free signal digest

The checkpoint SHALL decide from a digest that holds only numbers, booleans and
closed vocabularies: the checkpoint ordinal and trigger, the class, turns, cost
units, last and peak context tokens, the soft and hard thresholds, the stall
signal values, progress counts since the previous checkpoint, the diff size
numbers, the previous decision and its rule, and the signals already answered
with a steer. The digest SHALL NOT contain file contents, file paths, tool
arguments or results, error text, the run's own messages, credentials, tokens or
cookies. A tool name SHALL appear only when it is a registered tool name.

#### Scenario: A failing call's error text

- **WHEN** a run's last five calls of one tool failed with error output
- **THEN** the digest SHALL carry the tool name and the count
- **AND** it SHALL NOT carry any of the error output

#### Scenario: Task ticks and diff size

- **WHEN** the host samples the assigned change's ticked-task count and the worktree diff size at a checkpoint
- **THEN** only the counts SHALL enter the digest
- **AND** a sample that fails or exceeds its 2 s bound SHALL be recorded as unknown and SHALL NOT delay the run

### Requirement: Progress is measured from telemetry

A progress event SHALL be any of: a successful `edit` or `write` call; a change
of the sampled diff numbers; a new `HEAD` commit; an increase of the assigned
change's ticked-task count; and, for a read-only run, a call whose tool and
argument hash were not seen earlier in the run. The failing-tool signal SHALL
count only consecutive failed calls of one tool in a run that already had a
successful call, and SHALL be disabled for the fail-fast exempt roles. The
run's own statements SHALL NOT count as progress.

#### Scenario: Edits count, re-reads do not

- **WHEN** a worker run's last 40 turns contain only reads whose tool and argument hash it already used
- **THEN** the no-progress signal SHALL be present

#### Scenario: A run that never succeeded

- **WHEN** a run has had no successful tool call
- **THEN** the failing-tool signal SHALL NOT be present and the fail-fast monitor SHALL remain the only owner of that run's dead-tool behaviour

### Requirement: A fixed decision vocabulary decided by a deterministic rule set

Every checkpoint SHALL decide exactly one of `continue`, `steer`, `compact`,
`switch-model`, `escalate`. The first-release decider (`rules/v1`) SHALL apply
these rules in order, first match wins: `hard-limit` → `escalate`;
`no-progress-twice` (the previous checkpoint decided `continue` with zero
progress and this window has zero progress) → `escalate`; `steer-ignored` (a
signal already answered with a steer in this run is present again) →
`escalate`; `context` with an admissible compaction → `compact`;
`failing-tool`, `repeats`, `no-progress`, `cost-rising` → `steer` with that
signal's nudge; otherwise `default` → `continue`. The same digest SHALL always
yield the same decision. With steering disabled, the steer rules SHALL yield
`continue` and `steer-ignored` SHALL NOT apply.

#### Scenario: Nothing is wrong

- **WHEN** a run passes its soft threshold with progress events and no stall signal
- **THEN** the decision SHALL be `continue` with rule `default`

#### Scenario: Two zero-progress continues

- **WHEN** a checkpoint decided `continue` with zero progress and the next checkpoint again measures zero progress
- **THEN** the next decision SHALL be `escalate` with rule `no-progress-twice`

#### Scenario: Determinism

- **WHEN** the rule set is evaluated twice on the same digest
- **THEN** both evaluations SHALL return the same decision and rule

### Requirement: Steer sends a fixed nudge from a closed catalog

A `steer` decision SHALL submit exactly one pre-written message from a closed,
versioned catalog keyed by signal (`failing-tool`, `stop-rereading`,
`make-the-change`, `conclude`, `converge`), whose only variable parts are digest
numbers and a registered tool name. The decider SHALL NOT compose free text. The
message SHALL be submitted with the host's `steer` mode so it arrives at a turn
boundary, never inside a running tool call. Each signal SHALL be steered at most
once per run.

#### Scenario: Repeated reads

- **WHEN** the decision is `steer` for the repeats signal
- **THEN** the run SHALL receive the `stop-rereading` catalog message with the measured share filled in
- **AND** no other text SHALL be added

#### Scenario: The signal comes back

- **WHEN** a signal that was already steered in a run is present at a later checkpoint
- **THEN** the decision SHALL be `escalate` with rule `steer-ignored`

### Requirement: Compact uses the ceiling path and switch-model is not applied

A `compact` decision SHALL be admitted through the same serialized admission as
the cost-aware compaction ceiling, with the same summarizer, floor and loop
guard, and its compaction envelope SHALL carry the kind `auto-checkpoint`. A
`compact` that is not admissible SHALL NOT be selected. A `switch-model`
decision SHALL NOT change the run's model in this release: it SHALL be recorded
with `applied: false` and the run SHALL continue.

#### Scenario: Context above the threshold

- **WHEN** a run's measured context is at or above the context threshold and the ceiling's loop guard allows a compaction
- **THEN** the decision SHALL be `compact` and the compaction SHALL run through the ceiling admission path with kind `auto-checkpoint`

#### Scenario: A switch-model decision

- **WHEN** a decider returns `switch-model`
- **THEN** the run's model SHALL stay unchanged and the record SHALL say `applied: false`

### Requirement: Escalation is a normal developer question

An `escalate` decision SHALL file one developer question as the run, through the
existing `workflow question` contract and the run's capability, with a plain,
templated summary built only from the digest (class, step, turns against soft
and hard, cost units, context, signals, progress, the rule). It SHALL offer a
`continue` option, accept a custom-text direction, and state that cancelling the
question stops the run. A run SHALL have at most one open checkpoint question.
The host SHALL then: on an answer within the agent grace window, submit a fixed
message with the developer's custom text wrapped as untrusted developer content,
reset the run's escalation baseline and let it continue; on a cancellation, stop
the conversation at a turn boundary and record the run's `blocked` handoff
naming the cancelled question; when the question is still pending after the
grace window, stop the conversation at a turn boundary and record the run's
`blocked` handoff naming the pending question, leaving the existing asker-resume
to re-issue the run when the developer answers. A run SHALL NOT be stopped by an
escalation whose question was not recorded.

#### Scenario: Developer answers in time

- **WHEN** the developer answers the checkpoint question `continue` within the grace window
- **THEN** the run SHALL keep its session and receive the fixed continuation message
- **AND** the hard limit SHALL re-arm at the current turn plus the class's soft threshold

#### Scenario: Nobody answers in time

- **WHEN** the checkpoint question is still pending when the grace window ends
- **THEN** the run SHALL hand off `blocked` naming the pending question
- **AND** an answer arriving later SHALL re-issue the run through the existing asker-resume with the answer as prior dialogue

#### Scenario: The developer cancels

- **WHEN** the developer cancels the checkpoint question
- **THEN** the run SHALL be stopped and SHALL NOT be resumed by that question

#### Scenario: The question cannot be filed

- **WHEN** filing the checkpoint question fails
- **THEN** the run SHALL continue and a `runtime.checkpoint_escalation` envelope with outcome `filing-failed` SHALL be recorded

### Requirement: The checkpoint fails open

The checkpoint SHALL fail open: an exception, a timeout, a missing measurement,
a failed decision-record write, a failed steer or compaction, or a failed
question SHALL leave the run running as if the decision were `continue`, and
SHALL be recorded as a `runtime.checkpoint` envelope with `status: "error"` and a bounded error class.
A failed record write SHALL NOT cancel an otherwise safe `steer` or `compact`.

#### Scenario: Evaluation throws

- **WHEN** evaluating a checkpoint throws
- **THEN** the run SHALL continue unchanged
- **AND** a `runtime.checkpoint` envelope with `status: "error"` SHALL be recorded

### Requirement: Every checkpoint decision is recorded

Each checkpoint SHALL export one `runtime.checkpoint` envelope carrying its
ordinal, trigger, class, turns, cost units, context and peak context, signal
values, decision, rule, applied result, decider id, latency, whether it was
recorded in the workflow, and status. A run's first 12 checkpoints SHALL also be
recorded in the workflow's decision history through an authenticated
`workflow checkpoint` run command that appends one classifier decision record —
integration `progress-checkpoint`, phase the step id, question id
`checkpoint:<runId>:<ordinal>`, model the decider id, input the digest, the five
options, a `choice` answer with one-hot probabilities and no confidence, and the
applied result — and commits an event without any lifecycle transition. The
command SHALL refuse a run that is not active. The store schema version SHALL
remain 6.

#### Scenario: A recorded checkpoint

- **WHEN** a run's third checkpoint decides `steer`
- **THEN** the workflow's decision history SHALL gain one `progress-checkpoint` record whose answer is `steer` and whose result names the applied action and the rule
- **AND** the workflow's lifecycle state SHALL be unchanged

#### Scenario: Beyond the per-run cap

- **WHEN** a run evaluates its 13th checkpoint
- **THEN** its `runtime.checkpoint` envelope SHALL say `recorded: false` and no decision record SHALL be appended

### Requirement: Run-progress telemetry and the missing-decision alarm

`runtime.settled` SHALL carry the run's cost units, checkpoint count and
checkpoint escalation count beside its turns and peak context. The efficiency
tooling SHALL provide the queries `turn-distribution` (per class: runs, p50,
p90, p95, p99 and max turns for all runs and for successful runs, and the
outcome coverage), `run-progress` (per run: class, turns, cost, peak context,
second-half to first-half cost ratio, outcome, above soft or hard),
`progress-checkpoints` (decisions by class, decision and rule; escalations per
100 runs; progress after a steer) and `checkpoint-gaps` (runs that passed their
soft threshold with no checkpoint envelope or only errored ones), and a replay
that feeds recorded runs into the same rule module.

#### Scenario: A run above its soft threshold without a decision

- **WHEN** a run's settled turns exceed its class's soft threshold and the dataset holds no successful `runtime.checkpoint` envelope for it
- **THEN** `checkpoint-gaps` SHALL list that run

#### Scenario: Measuring the effect

- **WHEN** `run-progress` runs on a dataset
- **THEN** each run SHALL report its second-half to first-half cost ratio and whether it passed its soft or hard threshold

### Requirement: Checkpoint configuration

`[agents.checkpoint]` SHALL accept `enabled` (default `true`), `steer` (default
`true`), `contextTokens` (default 200,000) and per-class tables with integer
`softTurns` (at least 10) and `hardTurns` (at least twice `softTurns`). An
invalid table SHALL be a configuration error at load. With `enabled = false` no
checkpoint SHALL be evaluated.

#### Scenario: A hard limit below twice the soft threshold

- **WHEN** `[agents.checkpoint.worker]` sets `softTurns = 200` and `hardTurns = 300`
- **THEN** loading the configuration SHALL fail with an error naming that table
