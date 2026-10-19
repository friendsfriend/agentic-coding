## MODIFIED Requirements

### Requirement: Default subscription preserves current behaviour

While a session holds no explicit subscription, the server SHALL treat one
implicit `default` subscription as active: the events the current monitor
delivers (`review.waiting`, `question.pending`, `question.routed`,
`attention.raised`, `workflow.failed`, `effect.failed`, `workflow.completed`)
for the workflows the orchestrator started, in `digest` mode with a one minute
interval rather than an immediate wake per event. The digest SHALL batch info
progress only: an event whose severity is `warning` or above, an event whose id
names a wait, a block, a failure, a review or a question (`workflow.waiting`,
`run.blocked`, `run.failed`, `review.waiting`, `question.pending`, …), and a
workflow's `workflow.completed` or `workflow.closed` SHALL use the same wake
window an explicit `wake` subscription uses, so a digest never delays an event
that must be heard promptly. `list_subscriptions` SHALL show it, and any explicit
subscription SHALL replace it. A filter that names no `scope` reads as
`scope: "mine"`.

#### Scenario: No subscriptions, a review still wakes the session

- **WHEN** the orchestrator has created no subscription and one of its workflows
  enters a review step
- **THEN** the session SHALL receive one note naming that workflow on the wake
  window, not at the end of the digest interval

#### Scenario: No subscriptions, a failure is prompt

- **WHEN** the orchestrator has created no subscription and one of its workflows
  runs into a blocked or failed step, a raised attention request, or a pending
  developer question
- **THEN** the session SHALL receive a note naming that workflow on the wake
  window, not at the end of the digest interval

#### Scenario: No subscriptions, a completion is prompt

- **WHEN** the orchestrator has created no subscription and one of its workflows
  completes
- **THEN** the session SHALL receive a note naming that workflow on the wake
  window, and SHALL NOT wait for the digest interval

#### Scenario: No subscriptions, info progress waits for the digest

- **WHEN** the orchestrator has created no subscription and a step of one of its
  workflows enters or completes without a terminal event
- **THEN** the session SHALL NOT be woken before the digest interval elapses

#### Scenario: The default is visible and replaceable

- **WHEN** the orchestrator lists its subscriptions before subscribing
- **THEN** the listing SHALL name the implicit `default` subscription with its
  `digest` mode, and after one explicit subscription exists the listing SHALL NOT
  include it

### Requirement: Delivery modes and anti-storm guarantees

Delivery SHALL reuse the monitor's guarantees per subscription: events inside a
coalescing window become one note; `wake` mode SHALL deliver at most one note
per minute per session with overflow merged forward; `digest` mode SHALL
accumulate events and deliver at most once per `digestMinutes` (default 5),
except that an event which is immediate (severity `warning` or above, or an id
naming a wait, a block, a failure, a review or a question) or a workflow
completion SHALL use the subscription's wake window instead;
`silent` mode SHALL record the matched events and deliver no note. The system
SHALL bound a note to 20 event lines, bound the pending backlog to 200 events
(dropping and counting the oldest), and refuse to exceed 20 notes per trailing
hour per session, keeping the rest queued. A note SHALL therefore stay bounded
however many events one workflow produces, and no number of events SHALL wake a
session more often than its minimum interval.

#### Scenario: Burst of transitions

- **WHEN** three subscribed workflows change state inside the coalescing window
- **THEN** the session SHALL receive one note listing all three

#### Scenario: Digest cadence

- **WHEN** a `digest` subscription matches events at different times inside one
  digest interval
- **THEN** the session SHALL receive one note for that interval

#### Scenario: A digest never holds back an immediate event

- **WHEN** a `digest` subscription whose interval is longer than the wake window
  matches a blocked run, a failed effect, a waiting review or a pending question
- **THEN** the note SHALL be delivered on the wake window rather than at the end
  of the digest interval

#### Scenario: An explicit subscription keeps its own cadence

- **WHEN** a `wake`, `digest` or `silent` subscription the orchestrator created
  matches an event
- **THEN** its requested mode, filter, `coalesceMs`, `minIntervalMs` and
  `digestMinutes` SHALL still govern that event's delivery

#### Scenario: Silent records without delivering

- **WHEN** a `silent` subscription matches an event
- **THEN** the event SHALL be readable with `read_events` and the session SHALL
  receive no note

#### Scenario: Bounded note

- **WHEN** one note would list more events than the line bound
- **THEN** the note SHALL elide the rest with a count

#### Scenario: A storm cannot flood the session

- **WHEN** one workflow produces a thousand events inside one coalescing window
  and the session may not be woken again yet
- **THEN** the note SHALL list at most the line bound of them with one exact
  remainder line, the events SHALL NOT arrive as a burst of notes, and the
  events past the interval SHALL merge forward into one further bounded note

#### Scenario: A waiting review outranks the event budget

- **WHEN** the server has already spent a workflow's event budget for the window
  and the workflow enters developer review
- **THEN** the `review.waiting` event SHALL still be recorded and delivered; the
  budget applies to non-human-needed events only

### Requirement: De-duplicated, labelled notes

An event matched by more than one subscription SHALL appear as exactly one line,
and the note SHALL name every contributing subscription by label. A note SHALL
report each distinct (workflow, step, change) exactly once: the same change
repeated inside one note SHALL be one line carrying the number of events it
stands for (`- <workflowId> → <stepId> (<what changed>) ×N`, the suffix absent
for a single event). The note SHALL keep the `[workflow-monitor]` prefix, one
line per distinct change, in event-sequence and catalog order, and its elision
count SHALL count events. A note whose every line is info progress that no
contributing subscription named in its filter's `eventIds` or `categories` SHALL
be absorbed: the events SHALL stay recorded and readable with `read_events`, and
the session SHALL NOT be woken for that note. The orchestrator system prompt
SHALL explain the prefix, the count suffix, the absorbed no-op note, the
subscription labels and how to subscribe or pull with the event tools.

#### Scenario: One event, two subscriptions

- **WHEN** one event matches two subscriptions with different labels
- **THEN** the note SHALL contain one line for that event and SHALL list both
  labels

#### Scenario: A repeated failing effect is one counted line

- **WHEN** one workflow's effect fails twelve times inside one note's window
- **THEN** the note SHALL contain one line for that workflow, step and effect,
  suffixed with its count, instead of twelve identical lines

#### Scenario: A no-op note is absorbed

- **WHEN** a subscription whose filter names no event id (for example
  `minSeverity: "info"`) matches only info progress
- **THEN** the events SHALL be readable with `read_events` and the session SHALL
  NOT be woken by a note for them

#### Scenario: A note with one wanted line is delivered whole

- **WHEN** a note carries one change the subscription named beside progress it
  did not name
- **THEN** the whole note SHALL be delivered, its progress lines included

#### Scenario: Prompt explains the note

- **WHEN** the orchestrator system prompt is read
- **THEN** it SHALL describe the note prefix, the count suffix, the absorbed
  no-op note, the subscription labels and the subscribe/read tools
