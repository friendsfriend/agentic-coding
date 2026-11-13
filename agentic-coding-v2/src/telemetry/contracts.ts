// Telemetry wire records: the OTEL metric/log/span shapes the collector stores
// and the shell renders. Pure types and page-size constants — no store, view,
// server or database import belongs here.
export interface MetricData {
	resource: { attributes: Array<{ key: string; value: string }> };
	scope: { name: string; version: string };
	name: string;
	description: string;
	unit: string;
	type: "gauge" | "sum" | "histogram";
	dataPoints: MetricDataPoint[];
	serviceName: string;
}

export interface MetricDataPoint {
	startTimeUnixNano: string;
	timeUnixNano: string;
	value: number;
	bucketCounts?: number[];
	explicitBounds?: number[];
	attributes: Array<{ key: string; value: string }>;
}

export interface LogData {
	resource: { attributes: Array<{ key: string; value: string }> };
	scope: { name: string; version: string };
	timeUnixNano: string;
	severity: string;
	body: string;
	attributes: Array<{ key: string; value: string }>;
	traceId?: string;
	spanId?: string;
	serviceName: string;
}

export interface ServiceEdge {
	source: string;
	target: string;
	spanCount: number;
}
export interface ServiceGraph {
	services: ServiceNode[];
	edges: ServiceEdge[];
}

export interface ServiceNode {
	id: string;
	parentIds: string[];
	childIds: string[];
	spanCount: number;
	errorCount: number;
	avgDurationMs: number;
}

/** One event a span carries (an exception, a log point): the OTLP span event
 * shape, with its attributes normalized the way a span's are. */
export interface SpanEvent {
	name: string;
	timeUnixNano: string;
	attributes: Array<{ key: string; value: string }>;
}

export interface SpanData {
	traceId: string;
	spanId: string;
	parentSpanId: string;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	status: { code: number; message?: string };
	attributes: Array<{ key: string; value: string | number | boolean }>;
	resource: {
		attributes: Array<{ key: string; value: string | number | boolean }>;
		droppedAttributesCount: number;
	};
	scope: { name: string; version: string };
	serviceName: string;
	kind: number;
	/** Events the span reported. Absent for a source that carries none. */
	events?: SpanEvent[];
}

export interface TreeNode {
	/** A display-only edge break. Original parent IDs are never rewritten. */
	relation?: "cycle" | "depth-limit";
	span: SpanData;
	depth: number;
	expanded: boolean;
	children: TreeNode[];
}

export interface TraceSummary {
	traceId: string;
	rootSpans: SpanData[];
	startTime: bigint;
	endTime: bigint;
	durationMs: number;
	errorCount: number;
	spanCount: number;
	agents: string[];
	/** Distinct span (event) names the workflow contains, so the list can filter
	 * and search by span type without loading every span. */
	spanNames: string[];
}

/** One trace-list entry as the telemetry database aggregates it: a workflow
 * (change id) with its span count, time range, error count, agent roles and
 * span names. The list is paged from the database, so this row — not the loaded
 * spans — is the trace list's source of truth. Nanosecond timestamps stay
 * strings because they exceed the exact integer range of a JS number. */
/** Trace-list page size; the observability view and the database default agree. */
export const TRACE_PAGE_SIZE = 50;
/** Spans the service graph is built from when the topology view is opened. */
export const RECENT_SPAN_LIMIT = 3_000;

export interface TraceSummaryRow {
	changeId: string;
	spanCount: number;
	errorCount: number;
	startNanos: string;
	endNanos: string;
	agents: string[];
	spanNames: string[];
}

export interface TraceFilterCatalog {
	workspaces: Array<{ changeId: string; spanCount: number }>;
	spanTypes: string[];
}

/** One page of trace rows plus the total the filter matches. */
export interface TraceSummaryPage {
	items: TraceSummaryRow[];
	total: number;
	page: number;
	perPage: number;
}

/** Explicit, loopback-only metric sources; observations confer no identity. */
export type MetricCollectorKind = "statsd" | "prometheus";
export interface MetricCollectorState {
	revision: number;
	status: "stopped" | "starting" | "running" | "stopping";
	address: string | null;
	lastError: string | null;
}
export type MetricCollectorSnapshot = Record<
	MetricCollectorKind,
	MetricCollectorState
>;

/** Operator observation only. The credential is a private file reference,
 * never a token value. gRPC currently implements OTLP TraceService only. */
export interface TelemetryReceiverState {
	revision: number;
	status: "stopped" | "starting" | "running" | "stopping";
	protocol: "otlp-grpc-traces";
	address: string | null;
	credentialFile: string | null;
}
