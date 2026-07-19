# multi-protocol-gateway Specification

## Purpose
Define the receivers, normalisation, and signal routing to accept traces, metrics, and logs from OTLP gRPC, Zipkin, Datadog, Prometheus, and StatsD plus existing OTLP HTTP JSON.

## ADDED Requirements

### Requirement: OTLP gRPC receiver
The system SHALL accept OTLP gRPC requests on the configured gRPC port and route received signals to the appropriate typed store.

#### Scenario: gRPC sidecar forwards traces
- **WHEN** an application sends OTLP gRPC `ExportTraceServiceRequest` to configured port
- **THEN** the sidecar converter SHALL decode the protobuf payload
- **AND** SHALL forward normalised `SpanData` objects to the TraceStore via loopback HTTP JSON
- **AND** SHALL return gRPC `ExportTraceServiceResponse` with partial_success details

#### Scenario: gRPC sidecar forwards metrics
- **WHEN** an application sends OTLP gRPC `ExportMetricsServiceRequest` to configured port
- **THEN** the sidecar converter SHALL decode the protobuf payload
- **AND** SHALL forward normalised `MetricData` objects to the MetricStore via loopback HTTP JSON

#### Scenario: gRPC sidecar forwards logs
- **WHEN** an application sends OTLP gRPC `ExportLogsServiceRequest` to configured port
- **THEN** the sidecar converter SHALL decode the protobuf payload
- **AND** SHALL forward normalised `LogData` objects to the LogStore via loopback HTTP JSON

#### Scenario: gRPC sidecar is unavailable
- **WHEN** gRPC sidecar process has not been started
- **THEN** viewer SHALL continue operating with HTTP-only receivers
- **AND** SHALL show a status indicator that gRPC is not available

### Requirement: Zipkin receiver
The system SHALL accept Zipkin v2 JSON spans on HTTP and convert them to internal SpanData.

#### Scenario: Application sends Zipkin span
- **WHEN** application POSTs Zipkin v2 JSON span array to `/api/v2/spans`
- **THEN** receiver SHALL decode span list
- **AND** SHALL map Zipkin `traceId`, `id`, `parentId`, `name`, `timestamp`, `duration`, `tags`, `localEndpoint.serviceName` to internal `SpanData` fields
- **AND** SHALL push resulting spans into TraceStore

#### Scenario: Zipkin request is malformed
- **WHEN** receiver gets invalid Zipkin JSON or unsupported v1 format
- **THEN** receiver SHALL return HTTP 400
- **AND** SHALL continue running without crashing

### Requirement: Datadog receiver
The system SHALL accept Datadog Agent HTTP traces, metrics, and logs and convert them to internal typed models.

#### Scenario: Application sends Datadog trace
- **WHEN** application sends Datadog trace payload to `/v0.3/traces` or `/v0.4/traces` or `/v0.5/traces` or `/api/v0.2/traces`
- **THEN** receiver SHALL decode Datadog trace list
- **AND** SHALL map `trace_id`, `span_id`, `parent_id`, `name`, `service`, `resource`, `start`, `duration`, `error`, `meta` to internal `SpanData` fields
- **AND** SHALL push resulting spans into TraceStore

#### Scenario: Application sends Datadog series metrics
- **WHEN** application POSTs Datadog series metrics to `/api/v1/series` or `/api/v2/series`
- **THEN** receiver SHALL decode metric series
- **AND** SHALL normalise gauge/sum/rate metric types into `MetricData` objects
- **AND** SHALL push into MetricStore

#### Scenario: Application sends Datadog logs
- **WHEN** application POSTs Datadog log entries to `/api/v2/logs`
- **THEN** receiver SHALL decode log entries
- **AND** SHALL convert `message`, `status`, `timestamp`, `service`, `dd.trace_id`, `dd.span_id`, and custom attributes into `LogData` objects
- **AND** SHALL push into LogStore

### Requirement: Prometheus receiver
The system SHALL scrape Prometheus metric endpoints and convert exposed metrics to internal MetricData.

#### Scenario: Viewer scrapes Prometheus target
- **WHEN** viewer is configured with `--prom-target host:port`
- **THEN** receiver SHALL HTTP GET `/metrics` from target on scrape interval (default 15s)
- **AND** SHALL parse Prometheus text exposition format
- **AND** SHALL convert gauge, counter, histogram, and summary metric families into `MetricData` objects
- **AND** SHALL push into MetricStore

#### Scenario: Prometheus target is unreachable
- **WHEN** scrape target does not respond within timeout
- **THEN** receiver SHALL log the failure
- **AND** SHALL retry on next interval
- **AND** SHALL NOT block other receivers or viewer UI

### Requirement: StatsD receiver
The system SHALL listen for StatsD UDP datagrams and convert received metrics to internal MetricData.

#### Scenario: Application sends StatsD metric
- **WHEN** application sends UDP datagram to configured StatsD port (default 8125)
- **THEN** receiver SHALL parse StatsD line protocol: `<metricname>:<value>|<type>`
- **AND** SHALL support gauge (`g`), counter (`c`), timer (`ms`), and histogram (`h`) types
- **AND** SHALL aggregate same-name data points into `MetricData` objects
- **AND** SHALL push into MetricStore

#### Scenario: StatsD datagram is malformed
- **WHEN** receiver gets unparseable datagram
- **THEN** receiver SHALL silently drop the datagram
- **AND** SHALL continue listening without interruption

### Requirement: Signal routing isolation
Each receiver SHALL route signals only to the appropriate typed store and SHALL NOT mix signal types.

#### Scenario: OTLP batch contains mixed signals
- **WHEN** OTLP gRPC Export request contains both trace and metric signals
- **THEN** sidecar SHALL route trace signals to TraceStore
- **AND** SHALL route metric signals to MetricStore independently

#### Scenario: One receiver errors
- **WHEN** Zipkin receiver encounters a malformed payload
- **THEN** OTLP HTTP, OTLP gRPC, Datadog, Prometheus, and StatsD receivers SHALL continue operating unaffected
