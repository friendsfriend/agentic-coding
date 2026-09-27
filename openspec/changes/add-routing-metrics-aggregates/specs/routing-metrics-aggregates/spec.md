# Spec Delta

## Purpose

Turns the per-event classifier routing telemetry stream into observability
metrics — latency, pass and fallback counts, and provider errors by status class
— so routing quality can be judged across many workflows without reading traces.

## ADDED Requirements

### Requirement: Routing telemetry is aggregated into metrics

The metrics pipeline SHALL derive, from the classifier routing telemetry events
of the workflow stream, a classifier call latency histogram measured from the
provider call, a count of classification passes and of their fallbacks per
workflow, and a count of provider errors keyed by status class. Aggregates SHALL
be computed from bounded numeric and short scalar fields only, and a routing
event that omits a field SHALL contribute to no aggregate for that field.

#### Scenario: Successful pass contributes latency and pass counts

- **WHEN** a workflow's telemetry stream contains a successful
  `routing.response` with a reported duration and a `routing.classified` event
  with a fallback count
- **THEN** the metrics store SHALL contain one latency data point for the call
  and one pass data point whose fallback count matches the event

#### Scenario: Provider error is counted by status class

- **WHEN** the stream contains a `routing.response` with an error outcome and
  status class `5xx`
- **THEN** the metrics store SHALL count one provider error under status class
  `5xx`
- **AND** it SHALL NOT count an error under any other class

#### Scenario: Streaming events refresh the aggregates

- **WHEN** new routing telemetry is ingested
- **THEN** the routing aggregates SHALL include it without a process restart
  and without discarding previously aggregated data points
