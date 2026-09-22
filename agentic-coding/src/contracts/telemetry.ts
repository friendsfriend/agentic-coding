import { Schema } from "effect";

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

export interface ServiceNode {
	id: string;
	parentIds: string[];
	childIds: string[];
	spanCount: number;
	errorCount: number;
	avgDurationMs: number;
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
}

export interface TreeNode {
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

/** One page of trace rows plus the total the filter matches. */
export interface TraceSummaryPage {
	items: TraceSummaryRow[];
	total: number;
	page: number;
	perPage: number;
}

// ---------------------------------------------------------------------------
// Telemetry requests
// ---------------------------------------------------------------------------

export const telemetryScanRequestSchema = Schema.Struct({
	repo: Schema.String,
});

export const telemetryPruneRequestSchema = Schema.Struct({
	days: Schema.optional(Schema.Number),
});

/** One page of the trace list: entries are workflows, newest first. */
export const telemetryTracesRequestSchema = Schema.Struct({
	page: Schema.optional(Schema.Number),
	perPage: Schema.optional(Schema.Number),
	changeId: Schema.optional(Schema.String),
});

/** Span reads are bounded: either one workflow's spans or the newest spans
 * (the service graph), never the whole history. */
export const telemetrySpansRequestSchema = Schema.Struct({
	changeId: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.Number),
});

export const telemetryWatchRequestSchema = Schema.Struct({
	repo: Schema.String,
});

/** Managed-agent handoff across the transport (task 1.4/3.4): the CLI forwards
 * its authenticated caller environment and run capability; the server resolves
 * the run identity and the engine independently validates the capability, so
 * the instance session and the agent run remain distinct authorities. */

/** One page of the trace list. */
export const traceSummaryPageSchema = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			changeId: Schema.String,
			spanCount: Schema.Number,
			errorCount: Schema.Number,
			startNanos: Schema.String,
			endNanos: Schema.String,
			agents: Schema.Array(Schema.String),
			spanNames: Schema.Array(Schema.String),
		}),
	),
	total: Schema.Number,
	page: Schema.Number,
	perPage: Schema.Number,
});

/** Workspace watcher registrations the telemetry database knows. */
export const telemetryWorkspacesSchema = Schema.Struct({
	workspaces: Schema.Array(
		Schema.Struct({
			changeId: Schema.String,
			path: Schema.String,
			spanCount: Schema.Number,
		}),
	),
});

/** Bounded span read result. */
export const telemetrySpansSchema = Schema.Struct({
	spans: Schema.Array(Schema.Unknown),
});

/** Scan/prune return how many rows they touched. */
export const telemetryCountSchema = Schema.Struct({
	scanned: Schema.Number,
});

export const telemetryRemovedSchema = Schema.Struct({
	removed: Schema.Number,
});

/** Decoded request type for `telemetryScanRequestSchema`. */
export type TelemetryScanRequest = typeof telemetryScanRequestSchema.Type;

/** Decoded request type for `telemetryPruneRequestSchema`. */
export type TelemetryPruneRequest = typeof telemetryPruneRequestSchema.Type;

/** Decoded request type for `telemetryTracesRequestSchema`. */
export type TelemetryTracesRequest = typeof telemetryTracesRequestSchema.Type;

/** Decoded request type for `telemetrySpansRequestSchema`. */
export type TelemetrySpansRequest = typeof telemetrySpansRequestSchema.Type;

/** Decoded request type for `telemetryWatchRequestSchema`. */
export type TelemetryWatchRequest = typeof telemetryWatchRequestSchema.Type;
