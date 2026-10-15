# Spec Delta: durable-agent-tools

## Purpose

The durable runtime telemetry envelope set additionally reports compaction with
its reason, attempts, duration and measured token movement.

## MODIFIED Requirements

### Requirement: Runtime telemetry envelopes
Durable runs SHALL emit the existing runtime telemetry envelope (schema version 1, layer `runtime`, runtime `pi-durable`, workflow/run/step/role/profile identity) for turn, model response, tool start/end, compaction and settle events to the run's telemetry path and configured OTLP endpoint. The compaction envelopes SHALL carry the compaction reason (`manual`, `threshold` or `overflow`), whether a generation is blocked waiting for it, the attempt count, the measured duration, the tokens before and after when they are measurable from the conversation's own generation usage, and the outcome with a bounded, redacted error class when the summarizer failed or the compaction was aborted. Content SHALL be captured only when the run's content-capture opt-in is set, and secrets SHALL be redacted with the same rules as the pi bridge.

#### Scenario: Metadata-only by default
- **WHEN** a durable run completes a tool call without the content-capture opt-in
- **THEN** the emitted envelopes SHALL contain no prompt, model text, tool arguments or tool results

#### Scenario: Secret redaction
- **WHEN** content capture is enabled and a tool result contains a token matching the redaction rules
- **THEN** the envelope SHALL contain `[REDACTED]` in place of the token

#### Scenario: Compaction completes
- **WHEN** a compaction of the run's conversation completes
- **THEN** the emitted compaction envelope SHALL carry its reason, the blocking flag, the attempt count and the measured duration

#### Scenario: Summarizer fails
- **WHEN** the compaction task fails
- **THEN** the emitted compaction envelope SHALL carry the failed outcome and a bounded error class, without the summary text
