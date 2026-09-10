## ADDED Requirements

### Requirement: Stable dashboard action layout
The dashboard SHALL NOT render a generic transient action, progress, command-result, or handler-error text row in its primary content layout. It MUST preserve modal validation/errors and durable workflow health diagnostics as interactive or state-derived feedback. A notification overlay MAY be used only for an individually reviewed, concise confirmation of a requested user action or an actionable failure; it MUST NOT be used for progress, refresh, key, or debug events.

#### Scenario: Workflow action changes status
- **WHEN** a dashboard action begins and then completes or fails
- **THEN** the dashboard panels retain their layout without a generic transient status row
- **AND THEN** any required user-facing validation or error feedback remains available through its modal, a limited action-result notification overlay, or workflow health diagnostic

#### Scenario: Dashboard observation fails
- **WHEN** an asynchronous dashboard refresh cannot load workflow data
- **THEN** the dashboard SHALL NOT add the failure text as a transient inline message or a notification overlay
- **AND THEN** the resulting workflow health diagnostic remains visible when the state supplies one

#### Scenario: User action needs concise feedback
- **WHEN** a reviewed user-requested action completes with a concise confirmation or actionable failure
- **THEN** the dashboard MAY show one existing notification overlay for that outcome
- **AND THEN** it SHALL NOT render the outcome in the primary content layout

### Requirement: TUI operational trace export
The TUI SHALL emit a bounded OTLP span for each operational action outcome and diagnostic transition that formerly used the dashboard inline message channel or `AGENTIC_CODING_TRACE` debug-file instrumentation. Each span MUST use a stable event name, generated valid trace and span identifiers, completion timestamps, and an OK or ERROR status. Export failure MUST NOT alter TUI control flow or action outcomes.

#### Scenario: Dashboard action completes
- **WHEN** the user invokes a dashboard or overview workflow action that completes successfully
- **THEN** the TUI exports an OK OTLP span identifying the UI surface and action category
- **AND THEN** no dynamic status text is rendered in the dashboard layout

#### Scenario: Dashboard action fails
- **WHEN** a traced dashboard or overview action fails
- **THEN** the TUI exports an ERROR OTLP span identifying the action category
- **AND THEN** the original interactive error feedback behavior is retained without exposing the failure as a generic inline message

#### Scenario: TUI diagnostic occurs
- **WHEN** a TUI key-handler diagnostic, renderer lifecycle diagnostic, uncaught exception, or unhandled rejection occurs at an existing debug instrumentation point
- **THEN** the TUI exports a corresponding bounded OTLP span
- **AND THEN** it does not append that diagnostic to an `AGENTIC_CODING_TRACE` file

### Requirement: Safe trace attributes
TUI operational spans SHALL use only bounded, allowlisted scalar attributes needed to identify the event, UI surface, action category, or outcome. They MUST NOT include user-entered text, credentials, artifact content, or unbounded raw error text.

#### Scenario: Action receives dynamic input or fails with detailed text
- **WHEN** a traced action includes developer input or throws an error whose text contains dynamic details
- **THEN** the exported span contains stable classification attributes and status only
- **AND THEN** it does not contain the input or raw error text
