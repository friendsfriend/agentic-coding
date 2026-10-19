## ADDED Requirements

### Requirement: Shadow classifier decisions are recorded and never applied

Each checkpoint SHALL also ask, when `[agents.checkpoint] shadow =
"classifier"` is configured, the configured classifier a `choice` question over `continue`,
`steer`, `compact`, `switch-model` and `escalate` with the content-free digest as
its only state, SHALL record the answer in the checkpoint's `runtime.checkpoint`
envelope and, within the per-run record cap, as a `progress-checkpoint` decision
record with `result.applied = false`, and SHALL NOT apply it. A shadow failure
SHALL be recorded and SHALL NOT affect the run.

#### Scenario: Shadow disagrees with the rules

- **WHEN** the rules decide `continue` and the shadow classifier answers `escalate`
- **THEN** the run SHALL continue and both answers SHALL be recorded

### Requirement: The classifier decider keeps the rule guards

The rule guards SHALL stay final under the classifier decider: when
`[agents.checkpoint] decider = "classifier"` is configured, the rules
`hard-limit`, `no-progress-twice` and `steer-ignored` SHALL be evaluated first
and their decision SHALL be final. Otherwise the classifier's selected label
SHALL be applied, chosen as the explicit choice, else the most probable offered
label; `confidence` SHALL NOT be consulted. A missing, malformed, non-vocabulary
or late answer SHALL apply the rule decision. A classifier `steer` SHALL send the
catalog nudge of the strongest present signal and SHALL NOT be applied when no
signal is present.

#### Scenario: Hard limit under the classifier decider

- **WHEN** a run reaches its hard limit and the classifier would answer `continue`
- **THEN** the decision SHALL be `escalate` with rule `hard-limit`

#### Scenario: The classifier does not answer

- **WHEN** the classifier call times out
- **THEN** the rule decision SHALL be applied and the record SHALL name the fallback

### Requirement: The classifier becomes the default only through the acceptance gate

The efficiency tooling SHALL provide a `checkpoint-decider-eval` query that pairs
shadow and rule decisions with the next window's progress, the run's outcome and
its cost to completion. The shipped default decider SHALL remain `rules` unless
the evaluation over at least 200 shadowed checkpoints from at least 50 runs shows
that the classifier escalates no more often per 100 runs, is followed by progress
after `steer`/`compact` at least as often, and makes its first non-`continue`
decision no later on runs that ended `blocked` or `failed`.

#### Scenario: Not enough data

- **WHEN** fewer than 200 shadowed checkpoints are recorded
- **THEN** `checkpoint-decider-eval` SHALL report the gate as not met

### Requirement: The LLM advisor is off by default

`[agents.checkpoint] advisor` SHALL default to `off`. When enabled, the advisor
SHALL be consulted only after a classifier no-answer, SHALL receive only the
digest, and SHALL return one vocabulary label; any other answer, error or timeout
SHALL apply the rule decision. Its answer SHALL be recorded like any decider's.

#### Scenario: Default configuration

- **WHEN** `[agents.checkpoint]` does not set `advisor`
- **THEN** no advisor call SHALL be made
