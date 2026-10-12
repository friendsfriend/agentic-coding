## ADDED Requirements

### Requirement: Orchestrator names a model per step at start

`start_workflow` SHALL accept an optional per-step model selection that maps a
step id to an agent profile name, and the workflow start wire request SHALL
carry the same field so a start that is not the Orchestrator's can express it
too. The selection SHALL be validated before any agent launches: every key SHALL
name an agent step of the resolved definition, every value SHALL name a
configured agent profile (or the built-in model-agnostic profile), and a
rejected key or value SHALL fail the start with a diagnostic naming it. A
selection SHALL NOT be silently ignored, and a step the caller did not name
SHALL resolve through the preset and the configured fallback chain rather than
being refused.

#### Scenario: Orchestrator selects one step's model

- **WHEN** `start_workflow` names a configured profile for `core.plan` and starts an `openspec` workflow
- **THEN** the pinned routing SHALL use that profile for `core.plan`
- **AND** every other step SHALL resolve from the selected preset or the fallback chain

#### Scenario: Unknown step is refused

- **WHEN** a start names a step id that the resolved definition does not contain, or a step whose actor is not an agent
- **THEN** the start SHALL fail before any agent launches with a diagnostic naming that step
- **AND** no workflow row SHALL be created

#### Scenario: Unknown profile is refused

- **WHEN** a start names a profile that the effective agents configuration does not define
- **THEN** the start SHALL fail before any agent launches with a diagnostic naming the profile and the step it was chosen for

#### Scenario: A named step keeps the preset's model when it is not selected

- **WHEN** a start names models for two steps of a definition that has six agent steps
- **THEN** the two named steps SHALL use the named profiles
- **AND** the other four SHALL keep the models the selected preset resolves for them

### Requirement: Start-time selection is pinned, preflighted, and observable

The resolved per-step model SHALL be pinned into the workflow's metadata when
the workflow starts, together with the source each step's model came from: the
Orchestrator's explicit selection, the selected preset, or the fallback chain.
A later edit to the configuration SHALL NOT change what a running workflow
launches. Every resolved profile SHALL pass its step's capability requirements
— including the read-only policy of a step that declares it — and the
model-availability preflight before any agent launches, and any choice that
fails SHALL fail the start rather than launching and failing the run.

#### Scenario: Read-only step keeps its read-only policy

- **WHEN** a start names a writable profile for a step that declares the read-only requirement
- **THEN** the pinned profile for that step SHALL be the read-only form of the named profile
- **AND** the run SHALL launch with the read-only tool policy

#### Scenario: Unavailable model refuses the start

- **WHEN** a start names a profile whose configured model the runtime does not offer
- **THEN** the start SHALL fail before any agent launches with the existing model-availability diagnostic

#### Scenario: Pinned selection survives a configuration edit

- **WHEN** a running workflow's agents configuration is edited to change or remove a step's model
- **THEN** the running workflow SHALL keep launching the profiles pinned at start

### Requirement: Fusion roster selection

For a definition whose planning trait is fusion, the planner roster SHALL hold
between two and five distinct profile names. The roster SHALL be the explicit
selection's list for the definition's roster step when one is supplied, and
otherwise the preset's roster entry. An explicit roster SHALL be rejected when
it is not a list, when it holds fewer than two or more than five entries, or
when it repeats a profile; a list SHALL be rejected for any step other than the
definition's roster step. A fusion start with neither an explicit roster nor a
configured preset roster SHALL fail before any agent launches with a diagnostic
naming both remedies.

#### Scenario: Explicit roster becomes the fan-out

- **WHEN** a fusion start names three distinct profiles for the roster step
- **THEN** the pinned routing SHALL carry `planner-1` through `planner-3` with those profiles
- **AND** the consolidator SHALL resolve like any other single-model step

#### Scenario: Preset roster is used when none is named

- **WHEN** a fusion start names no roster and the selected preset declares a roster entry of three distinct profiles
- **THEN** the planner fan-out SHALL use those three profiles

#### Scenario: Malformed roster is refused

- **WHEN** a start names one profile, six profiles, or a repeated profile for the roster step
- **THEN** the start SHALL fail before any agent launches with a diagnostic naming the roster rule

#### Scenario: Fusion start without any roster fails

- **WHEN** a fusion workflow is started with no explicit roster and a preset that declares none
- **THEN** the start SHALL fail before any agent launches
- **AND** the diagnostic SHALL name both the roster input and Settings → Presets

### Requirement: A preset is not required to start a workflow

No workflow start SHALL fail because no preset is selected. A start without a
preset SHALL resolve each step from the explicit selection and then through the
configured fallback chain down to the built-in model-agnostic profile, and SHALL
record the source of each step's resolved model. The per-step pool coverage
refusal and the classifier-routed-workflow-requires-a-preset refusal SHALL NOT
exist.

#### Scenario: Preset-less start resolves through the fallback chain

- **WHEN** a workflow that would previously have been classifier-routed is started without a preset
- **THEN** the start SHALL succeed
- **AND** every step SHALL resolve through the configured routes, definition defaults, or the built-in profile
- **AND** each step's recorded source SHALL be the fallback chain

#### Scenario: Preset-less fusion still needs a roster

- **WHEN** a fusion workflow is started without a preset and without an explicit roster
- **THEN** the start SHALL fail with the roster diagnostic rather than launching a collapsed fan-out

### Requirement: Preset switch keeps the pinned selection

A preset switch SHALL re-resolve every step from the newly selected preset and
SHALL re-apply the pinned explicit selections for the steps the definition
still contains, refreshing each step's recorded source. A pinned selection that
no longer resolves — an unknown profile, or a roster that no longer holds two
to five distinct profiles — SHALL be dropped and recorded as attention instead
of failing the switch.

#### Scenario: Switch keeps the Orchestrator's choices

- **WHEN** a workflow whose `core.implementation` was pinned to a named profile switches to another preset
- **THEN** `core.implementation` SHALL keep that profile
- **AND** every other step SHALL take the new preset's model

#### Scenario: A removed profile is dropped with attention

- **WHEN** a switch runs after the profile pinned for a step was deleted from the configuration
- **THEN** the switch SHALL succeed
- **AND** that step SHALL resolve from the new preset instead
- **AND** the workflow SHALL record an attention entry naming the dropped selection

### Requirement: Chosen model is reported per step

The workflow view SHALL expose, for every agent step, the model profile the run
pinned and whether it came from the Orchestrator, the preset, or the fallback
chain. The system SHALL export one content-free start-time telemetry event
carrying one row per resolved step with its step id, profile, and source,
bounded and redacted like every other telemetry payload, and emitting it SHALL
never change a start or fail a workflow.

#### Scenario: View reports the pinned model per step

- **WHEN** a workflow's view is read after a start that named models for two steps
- **THEN** each agent step SHALL report its pinned profile and its source

#### Scenario: Start-time event lists every resolved step

- **WHEN** a workflow starts with a per-step selection
- **THEN** one start-time telemetry event SHALL be exported with one row per resolved agent step
- **AND** every row SHALL carry the step id, the profile, and the source
- **AND** no task text, artifact content, or prompt SHALL appear in the event

#### Scenario: Telemetry failure does not fail the start

- **WHEN** the start-time telemetry event cannot be built, bounded, redacted, or written
- **THEN** the start SHALL proceed with the resolved routing

### Requirement: Orchestrator prompt and tool descriptions gather the choice

The Orchestrator's system prompt SHALL tell it to gather the per-step model
choice from the developer before starting a workflow when the request implies
one — an explicit model or cost/quality preference, or a workflow whose planner
fan-out needs a roster — to state which models it used when it did not ask, and
never to claim a model choice that was not applied. `list_agent_config` SHALL
report the presets with the model each resolves per step, the configured
profiles with their runtime and model, the built-in model-agnostic profile, the
models the configured runtime offers, and the agent steps a start may select
models for, each with its pool mode. The `start_workflow` description SHALL name
the per-step model selection input.

#### Scenario: Prompt asks before starting when a choice is implied

- **WHEN** the developer asks for work that should run on a named or otherwise preferred model, or for a fusion workflow
- **THEN** the Orchestrator prompt SHALL direct it to settle the per-step models with the developer before starting
- **AND** the started workflow's pinned selection SHALL be the one it stated

#### Scenario: Discovery answers with presets, profiles, models, and steps

- **WHEN** the Orchestrator calls `list_agent_config`
- **THEN** the answer SHALL list the presets with their per-step models, the configured and built-in profiles, the models the configured runtime offers, and the selectable agent steps with their pool modes

#### Scenario: No fabricated choice is reported

- **WHEN** the Orchestrator starts a workflow without naming any model
- **THEN** it SHALL describe the run as using the preset's models
- **AND** it SHALL NOT report a model choice it did not make
