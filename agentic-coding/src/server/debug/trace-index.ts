// The live trace index behind `otel_query` (`add-agent-debug-tools`).
//
// The server owns the OTLP listeners, so it is also the one place that sees
// every span an app exports. This index keeps the newest of them in memory,
// keyed by the workflow that produced them (`ac.owner`), which is what makes a
// query answerable for one workflow's app and not for another's.
//
// Two rules decide what is queryable at all:
//
//   * a span without `ac.owner` is nobody's, so it is not indexed — the
//     workflow telemetry the shell also receives is not app telemetry, and a
//     query must not answer with it; and
//   * `ac.run` names the slot grant, so two runs of the same app under the same
//     workflow stay distinguishable even though host and port are identical.
//
// Every bound is a hard one, because the input is whatever an app exports: the
// retained traces, the spans per trace, the returned traces, the returned spans
// and the characters one attribute contributes.
import type { SpanData, SpanEvent } from "../../contracts/telemetry.ts";

/** Newest traces the index holds; older ones are evicted first. */
export const MAX_INDEXED_TRACES = 200;
/** Spans one retained trace may hold; a runaway trace is cut, not kept whole. */
export const MAX_INDEXED_SPANS_PER_TRACE = 500;
/** Spans one span-tree answer may carry. */
export const MAX_TREE_SPANS = 200;
/** Trace rows one list answer carries by default, and at most. */
export const DEFAULT_TRACE_LIMIT = 20;
export const MAX_TRACE_LIMIT = 100;
/** One attribute value's bound: `db.statement` is the reason it exists. */
export const MAX_ATTRIBUTE_CHARS = 500;
/** Events and event attributes one span node may carry. */
export const MAX_SPAN_EVENTS = 20;
/** The character budget of one answer (the tool layer truncates too). */
export const MAX_OUTPUT_CHARS = 40_000;

/** The resource attributes attribution is read from. */
export const AC_OWNER_ATTRIBUTE = "ac.owner";
export const AC_RUN_ATTRIBUTE = "ac.run";
export const AC_APP_ATTRIBUTE = "ac.app";

/** Attribute prefixes worth carrying into a span-tree answer: the request, the
 * database call, the messaging hop and whatever explains a failure. Everything
 * else stays in the receiver's own view of the trace. */
const KEY_ATTRIBUTE_PREFIXES = [
	"http.",
	"db.",
	"rpc.",
	"messaging.",
	"exception.",
	"error",
	"net.peer",
	"server.",
];

/** One trace row, as the list mode reports it. */
export interface TraceRow {
	readonly traceId: string;
	readonly root: string;
	readonly durationMs: number;
	readonly status: "error" | "ok" | "unset";
	readonly errorCount: number;
	readonly startedAt: string;
	readonly app?: string;
	readonly run?: string;
	readonly spanCount: number;
}

export interface TraceListResult {
	readonly owner: string;
	readonly traces: TraceRow[];
	/** Traces of this owner that matched the filters. */
	readonly matched: number;
	readonly truncated: boolean;
	/** Whether the index dropped older traces of this owner. */
	readonly indexTruncated: boolean;
}

/** One node of a span tree. */
export interface SpanNode {
	readonly spanId: string;
	readonly parentSpanId: string;
	readonly name: string;
	readonly durationMs: number;
	readonly status: "error" | "ok" | "unset";
	readonly service: string;
	readonly attributes?: Readonly<Record<string, string>>;
	readonly events?: ReadonlyArray<{
		readonly name: string;
		readonly time: string;
		readonly attributes?: Readonly<Record<string, string>>;
	}>;
	readonly children: SpanNode[];
}

export interface TraceTreeResult {
	readonly owner: string;
	readonly traceId: string;
	readonly app?: string;
	readonly run?: string;
	readonly spans: SpanNode[];
	readonly spanCount: number;
	readonly truncated: boolean;
}

export interface TraceQuery {
	readonly app?: string;
	readonly since?: string;
	readonly status?: "all" | "error" | "success";
	readonly name?: string;
	readonly limit?: number;
}

/** A refusal the route answers with its own status instead of a 500. */
export class TraceIndexError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = "TraceIndexError";
		this.code = code;
		this.status = status;
	}
}

function resourceAttribute(span: SpanData, key: string): string | undefined {
	const value = span.resource?.attributes?.find(
		(attribute) => attribute.key === key,
	)?.value;
	if (value === undefined) return undefined;
	const text = String(value);
	return text === "" ? undefined : text;
}

function nanos(value: string | undefined): bigint {
	if (value === undefined) return 0n;
	try {
		return BigInt(value);
	} catch {
		return 0n;
	}
}

function durationMs(startNs: bigint, endNs: bigint): number {
	if (endNs <= startNs) return 0;
	return Number((endNs - startNs) / 1000n) / 1000;
}

function instant(atNs: bigint): string {
	return new Date(Number(atNs / 1_000_000n)).toISOString();
}

function statusOf(span: SpanData): "error" | "ok" | "unset" {
	if (span.status?.code === 2) return "error";
	if (span.status?.code === 1) return "ok";
	return "unset";
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * The one value of a resource attribute across a trace's spans, or `undefined`
 * when they disagree. A row names the app (or the grant) it belongs to or names
 * none; it never invents one.
 */
function sharedAttribute(
	spans: readonly SpanData[],
	key: string,
): string | undefined {
	let found: string | undefined;
	for (const span of spans) {
		const value = resourceAttribute(span, key);
		if (value === undefined) continue;
		if (found === undefined) found = value;
		else if (found !== value) return undefined;
	}
	return found;
}

/** The attributes one span tree node carries: the request, the data access and
 * the failure detail, each value bounded. */
function keyAttributes(span: SpanData): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const attribute of span.attributes ?? []) {
		if (
			!KEY_ATTRIBUTE_PREFIXES.some((prefix) => attribute.key.startsWith(prefix))
		)
			continue;
		out[attribute.key] = truncate(String(attribute.value), MAX_ATTRIBUTE_CHARS);
	}
	return Object.keys(out).length === 0 ? undefined : out;
}

function eventNode(event: SpanEvent): {
	name: string;
	time: string;
	attributes?: Record<string, string>;
} {
	const attributes: Record<string, string> = {};
	for (const attribute of (event.attributes ?? []).slice(0, MAX_SPAN_EVENTS))
		attributes[attribute.key] = truncate(
			String(attribute.value),
			MAX_ATTRIBUTE_CHARS,
		);
	return {
		name: event.name,
		time: instant(nanos(event.timeUnixNano)),
		...(Object.keys(attributes).length === 0 ? {} : { attributes }),
	};
}

function boundLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0)
		return DEFAULT_TRACE_LIMIT;
	return Math.min(MAX_TRACE_LIMIT, Math.floor(limit));
}

/** The root span of a trace: the earliest span nothing in the trace parents. A
 * partial export whose every span has a parent falls back to its earliest. */
function rootOf(spans: readonly SpanData[]): SpanData {
	const ids = new Set(spans.map((span) => span.spanId));
	const roots = spans.filter(
		(span) => span.parentSpanId === "" || !ids.has(span.parentSpanId),
	);
	return (roots.length > 0 ? roots : [...spans]).reduce((earliest, span) =>
		nanos(span.startTimeUnixNano) < nanos(earliest.startTimeUnixNano)
			? span
			: earliest,
	);
}

function summarize(traceId: string, spans: readonly SpanData[]): TraceRow {
	let startNs: bigint | undefined;
	let endNs: bigint | undefined;
	let errorCount = 0;
	for (const span of spans) {
		const start = nanos(span.startTimeUnixNano);
		const end = nanos(span.endTimeUnixNano);
		if (startNs === undefined || start < startNs) startNs = start;
		if (endNs === undefined || end > endNs) endNs = end;
		if (statusOf(span) === "error") errorCount++;
	}
	const start = startNs ?? 0n;
	const root = rootOf(spans);
	const app = sharedAttribute(spans, AC_APP_ATTRIBUTE);
	const run = sharedAttribute(spans, AC_RUN_ATTRIBUTE);
	return {
		traceId,
		root: root.name,
		durationMs: durationMs(start, endNs ?? start),
		status: errorCount > 0 ? "error" : statusOf(root),
		errorCount,
		startedAt: instant(start),
		...(app === undefined ? {} : { app }),
		...(run === undefined ? {} : { run }),
		spanCount: spans.length,
	};
}

/**
 * The spans one workflow exported, newest traces first and bounded on every
 * axis. Nothing here is durable: it is the live view of what the receivers
 * decoded, so it holds for as long as this process does.
 */
export class TraceIndex {
	private readonly byOwner = new Map<string, Map<string, SpanData[]>>();
	/** Trace insertion order, so eviction is oldest-first. */
	private readonly order: Array<{ owner: string; traceId: string }> = [];
	/** Traces this index dropped per owner, so an answer can say so. */
	private readonly evicted = new Map<string, number>();

	/** Index every span that names its owner. Returns how many were indexed. */
	push(spans: readonly SpanData[]): number {
		let indexed = 0;
		for (const span of spans) {
			const owner = resourceAttribute(span, AC_OWNER_ATTRIBUTE);
			if (owner === undefined || span.traceId === "") continue;
			let traces = this.byOwner.get(owner);
			if (!traces) {
				traces = new Map<string, SpanData[]>();
				this.byOwner.set(owner, traces);
			}
			let bucket = traces.get(span.traceId);
			if (!bucket) {
				bucket = [];
				traces.set(span.traceId, bucket);
				this.order.push({ owner, traceId: span.traceId });
			}
			bucket.push(span);
			if (bucket.length > MAX_INDEXED_SPANS_PER_TRACE)
				bucket.splice(0, bucket.length - MAX_INDEXED_SPANS_PER_TRACE);
			indexed++;
		}
		this.evict();
		return indexed;
	}

	private evict(): void {
		while (this.order.length > MAX_INDEXED_TRACES) {
			const oldest = this.order.shift();
			if (!oldest) return;
			const traces = this.byOwner.get(oldest.owner);
			if (!traces) continue;
			traces.delete(oldest.traceId);
			this.evicted.set(oldest.owner, (this.evicted.get(oldest.owner) ?? 0) + 1);
			if (traces.size === 0) this.byOwner.delete(oldest.owner);
		}
	}

	/** Traces this index holds for one owner. */
	size(owner: string): number {
		return this.byOwner.get(owner)?.size ?? 0;
	}

	/** The trace summaries of one workflow, newest first. */
	list(owner: string, query: TraceQuery = {}): TraceListResult {
		const since =
			query.since === undefined ? undefined : Date.parse(query.since);
		if (since !== undefined && !Number.isFinite(since))
			throw new TraceIndexError(
				"invalid-since",
				`since must be an ISO 8601 instant, received ${JSON.stringify(query.since)}`,
			);
		const app = query.app?.trim();
		const name = query.name?.trim().toLowerCase();
		const limit = boundLimit(query.limit);
		const rows: TraceRow[] = [];
		for (const [traceId, spans] of this.byOwner.get(owner) ?? []) {
			if (spans.length === 0) continue;
			if (
				app !== undefined &&
				app !== "" &&
				sharedAttribute(spans, AC_APP_ATTRIBUTE) !== app
			)
				continue;
			if (
				name !== undefined &&
				name !== "" &&
				!spans.some((span) => span.name.toLowerCase().includes(name))
			)
				continue;
			const row = summarize(traceId, spans);
			if (since !== undefined && Date.parse(row.startedAt) < since) continue;
			if (query.status === "error" && row.status !== "error") continue;
			if (query.status === "success" && row.status === "error") continue;
			rows.push(row);
		}
		rows.sort(
			(left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt),
		);
		return {
			owner,
			traces: rows.slice(0, limit),
			matched: rows.length,
			truncated: rows.length > limit,
			indexTruncated: (this.evicted.get(owner) ?? 0) > 0,
		};
	}

	/**
	 * One trace's span tree, limited to the calling workflow's spans: a trace
	 * that also carries another workflow's spans answers with only this one's.
	 */
	tree(owner: string, traceId: string): TraceTreeResult | undefined {
		const spans = this.byOwner.get(owner)?.get(traceId);
		if (!spans || spans.length === 0) return undefined;
		const kept = [...spans]
			.sort((left, right) => {
				const delta =
					nanos(left.startTimeUnixNano) - nanos(right.startTimeUnixNano);
				if (delta < 0n) return -1;
				if (delta > 0n) return 1;
				return left.spanId.localeCompare(right.spanId);
			})
			.slice(0, MAX_TREE_SPANS);
		const nodes = new Map<string, SpanNode>();
		for (const span of kept) {
			const attributes = keyAttributes(span);
			nodes.set(span.spanId, {
				spanId: span.spanId,
				parentSpanId: span.parentSpanId,
				name: span.name,
				durationMs: durationMs(
					nanos(span.startTimeUnixNano),
					nanos(span.endTimeUnixNano),
				),
				status: statusOf(span),
				service: span.serviceName,
				...(attributes === undefined ? {} : { attributes }),
				...(span.events?.length
					? { events: span.events.slice(0, MAX_SPAN_EVENTS).map(eventNode) }
					: {}),
				children: [],
			});
		}
		const roots: string[] = [];
		for (const span of kept) {
			const node = nodes.get(span.spanId);
			if (!node) continue;
			const parent =
				span.parentSpanId === "" ? undefined : nodes.get(span.parentSpanId);
			if (parent) parent.children.push(node);
			else roots.push(span.spanId);
		}
		const app = sharedAttribute(kept, AC_APP_ATTRIBUTE);
		const run = sharedAttribute(kept, AC_RUN_ATTRIBUTE);
		return {
			owner,
			traceId,
			...(app === undefined ? {} : { app }),
			...(run === undefined ? {} : { run }),
			spans: roots.map((id) => nodes.get(id) as SpanNode),
			spanCount: kept.length,
			truncated: kept.length < spans.length,
		};
	}
}
