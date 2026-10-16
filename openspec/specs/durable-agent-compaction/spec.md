# durable-agent-compaction Specification

## Purpose
TBD - created by archiving change add-agent-compaction. Update Purpose after archive.
## Requirements
### Requirement: Compaction policy resolution

The system SHALL resolve one compaction policy per durable host from the
`[agents.compaction]` section of the canonical layered workflow configuration,
with `agentHost.compaction` taking precedence when it is present. Each token
field SHALL accept either an absolute token count or a percentage of the model's
context window, and a percentage SHALL resolve against a reference window when
one is known and fall back to that field's documented absolute default when it
is not. The resolved policy SHALL always carry `enabled`, `reserveTokens`,
`keepRecentTokens` and `backgroundTokens`. The documented defaults SHALL be
`enabled: true`, `reserveTokens: max(32000, 30% of the reference window)`,
`backgroundTokens: 32000` and `keepRecentTokens: 20000`, and the resolved policy
SHALL be reported to the developer (Settings shows the effective values, each
field's documented default and the reference window).

The reserve SHALL be the larger of its absolute default and 30% of a known
reference window, so automatic compaction starts when a request would exceed 70%
of the model's context window rather than at an absolute count only; with no
known window it SHALL resolve to the absolute 32000. The other two token fields
SHALL default to their absolute values.

#### Scenario: No configuration present

- **WHEN** neither `agents.compaction` nor `agentHost.compaction` is configured
- **THEN** the resolved policy SHALL be the documented defaults, with
  `reserveTokens` resolved to 32000 when no reference window is known

#### Scenario: A real 1M-token window with no configuration

- **WHEN** a run uses a model whose context window is 1000000 tokens and no compaction value is configured
- **THEN** the resolved `reserveTokens` SHALL be 300000 and threshold compaction SHALL start above 700000 estimated context tokens, `backgroundTokens` SHALL remain 32000 and `keepRecentTokens` SHALL remain 20000

#### Scenario: Percentage value with a known reference window

- **WHEN** `keepRecentTokens` is `"15%"` and the reference window resolves to 200000 tokens
- **THEN** the resolved `keepRecentTokens` SHALL be 30000

#### Scenario: Percentage value with no known window

- **WHEN** a percentage value is configured and no tracked run's model window is known
- **THEN** that field SHALL resolve to its documented absolute default instead of failing

#### Scenario: Bounds are enforced

- **WHEN** a configured `keepRecentTokens` would leave no room below a known reference window's reserve
- **THEN** the resolved value SHALL be clamped so threshold compaction can still select a range, and `backgroundTokens` of `0` SHALL disable background compaction

#### Scenario: Invalid configuration is rejected

- **WHEN** a compaction value is not a non-negative integer or a bounded percentage string
- **THEN** the write SHALL be rejected naming the field and the previously stored configuration SHALL remain in effect

### Requirement: Reference window from tracked runs

The reference window for percentage resolution SHALL be the smallest context
window among the models the host's tracked runs use, resolved through the host's
model catalog; it SHALL be recomputed when a run is added, when a run's model is
changed, and when the configuration changes.

#### Scenario: Two models in one workflow

- **WHEN** one tracked run uses a 128000-token model and another uses a 1000000-token model
- **THEN** percentages SHALL resolve against 128000

#### Scenario: Live model override

- **WHEN** the developer changes a run's model with `/model` to a model with a smaller context window
- **THEN** the reference window SHALL shrink to that model's window

### Requirement: Live policy application

The compaction policy SHALL be read at every resolution rather than fixed when
the host opens, so a configuration change SHALL affect running conversations
without restarting the host. `enabled` SHALL gate threshold and overflow
compaction only and SHALL NOT disable manual compaction.

#### Scenario: Setting changed while a run works

- **WHEN** the developer saves a new reserve in Settings while a durable run is working
- **THEN** that conversation's next generation preparation SHALL use the new reserve without a host restart

#### Scenario: Disabled automatic compaction

- **WHEN** `enabled` is false and the developer runs `/compact` in the session
- **THEN** the manual compaction SHALL still be admitted

### Requirement: Manual compaction outcomes

`/compact` SHALL be served by the run's agent host, which SHALL admit at most
one manual compaction per conversation at a time and SHALL report one
structured outcome: started (with the compaction task identity), already
compacting (naming the reason of the compaction in flight, without admitting a
second task), nothing to compact (the conversation holds no compactor-eligible
range), or an error for a run the host does not track (a finished run). The
command SHALL accept optional free-text instructions for the summarizer, bounded
in length, and SHALL be available for a read-only run because compaction
rewrites conversation context and not the repository.

#### Scenario: Compaction started

- **WHEN** the developer submits `/compact focus on the open findings` for a working run
- **THEN** the host SHALL admit a manual compaction carrying those instructions and SHALL report `started`

#### Scenario: Already compacting

- **WHEN** a compaction is already listed for the run
- **THEN** the host SHALL report `already-compacting` with its reason and SHALL NOT admit a second compaction task

#### Scenario: Nothing to compact

- **WHEN** the conversation has no eligible range to summarize
- **THEN** the host SHALL report `nothing-to-compact` and no summary entry SHALL be written

#### Scenario: Run has finished

- **WHEN** `/compact` is submitted for a run the host no longer tracks
- **THEN** the session SHALL report that the run has finished and that nothing was compacted, without an unhandled error

#### Scenario: Read-only run

- **WHEN** the developer submits `/compact` for a read-only verifier run
- **THEN** the compaction SHALL be admitted like any other

### Requirement: Compaction feedback

The surface SHALL show compaction as it happens: a running compaction with its
reason (manual or automatic), the outcome when it finishes with the tokens
before and after the summary when those are measurable, the failure with a
bounded error when the summarizer fails, and an aborted compaction when the run
is aborted. Token movement SHALL be measured from the conversation's own
generation usage around the compaction entry, and SHALL be omitted rather than
invented when it cannot be measured. The Agents panel and the session status
SHALL show a compaction indicator carrying the reason.

#### Scenario: Manual compaction runs

- **WHEN** a manual compaction is in flight
- **THEN** the transcript SHALL show it as running with the manual reason and the session status SHALL show the compaction indicator

#### Scenario: Compaction finished

- **WHEN** a compaction completes and a later generation reports prompt usage
- **THEN** the transcript SHALL show the finished compaction with the measured tokens before and after

#### Scenario: Summarizer failed

- **WHEN** the summarizer request fails
- **THEN** the session SHALL show the failure with a bounded error and the transcript SHALL NOT show a summary that was never placed

#### Scenario: Aborted by the developer

- **WHEN** the developer aborts the run while a manual compaction is in flight
- **THEN** the transcript SHALL show the compaction as aborted and no summary SHALL be placed

