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
}

/** One trace-list entry as the telemetry database aggregates it: a workflow
 * (change id) with its span count, time range, error count and agent roles. The
 * list is paged from the database, so this row — not the loaded spans — is the
 * trace list's source of truth. Nanosecond timestamps stay strings because they
 * exceed the exact integer range of a JS number. */
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
}

/** One page of trace rows plus the total the filter matches. */
export interface TraceSummaryPage {
	items: TraceSummaryRow[];
	total: number;
	page: number;
	perPage: number;
}
