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
import type {
	LogData,
	SpanData,
	SpanEvent,
} from "../../contracts/telemetry.ts";

/** Newest traces the index holds; a background trace is evicted before a
 * request trace, and the oldest of that class first. */
export const MAX_INDEXED_TRACES = 200;
/** Evicted trace ids one owner is remembered by, newest kept: enough to tell a
 * span tree "this trace was here and was evicted" from "this trace never
 * arrived". */
export const MAX_REMEMBERED_EVICTIONS = 500;
/** Spans one retained trace may hold; a runaway trace is cut, not kept whole. */
export const MAX_INDEXED_SPANS_PER_TRACE = 500;
/** Spans one span-tree answer may carry. */
export const MAX_TREE_SPANS = 200;
/** Trace rows one list answer carries by default, and at most. */
export const DEFAULT_TRACE_LIMIT = 20;
export const MAX_TRACE_LIMIT = 100;
/** Log records one owner may retain, newest kept. */
export const MAX_INDEXED_LOGS = 2000;
/** Log rows one list answer carries by default, and at most. */
export const DEFAULT_LOG_LIMIT = 50;
export const MAX_LOG_LIMIT = 200;
/** One log body's bound: an exception dump is the reason it exists. */
export const MAX_LOG_BODY_CHARS = 500;
/** Attribute entries one log row carries, each bounded like a span's. */
export const MAX_LOG_ATTRIBUTES = 20;
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
	/** The root span's OTLP kind (`server` for an inbound request), so a caller
	 * can tell a request trace from a background one. */
	readonly rootKind: string;
}

export interface TraceListResult {
	readonly owner: string;
	readonly traces: TraceRow[];
	/** Traces of this owner that matched the filters. */
	readonly matched: number;
	readonly truncated: boolean;
	/** Whether the index dropped older traces of this owner. */
	readonly indexTruncated: boolean;
	/** Matching traces the default noise ordering pushed out of the answer. */
	readonly noiseDropped: number;
	/** Traces of this owner the filters were applied to, before any of them
	 * removed one. */
	readonly considered: number;
	/** How many of `considered` each active filter rejected on its own. Every
	 * active filter appears (a `0` included), so an answer with `matched: 0`
	 * names the filter that removed the traces instead of leaving a bare zero. */
	readonly filtered: Readonly<Record<string, number>>;
	/** How to see the dropped traces, and which filter removed what, when either
	 * needs saying. */
	readonly notice?: string;
}

/** A trace id is an opaque hex string; the receiver lowercases it, and a caller
 * that pastes it back with different case must still find its trace. */
function normalizeTraceId(value: string): string {
	return value.trim().toLowerCase();
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
	/** Only traces with at least this many spans. */
	readonly minSpans?: number;
	/** Only traces whose root span has this OTLP kind (`server`, `client`, …). */
	readonly rootKind?: string;
	/** Only traces whose root span names this HTTP route/target/url. */
	readonly http?: string;
	/** Drop traces whose every span name contains this (a background poller). */
	readonly excludeNames?: string;
	/** Rank the single-span background traces among the rest instead of after
	 * them, and do not report them as dropped. */
	readonly includeNoise?: boolean;
}

/** One log record, as the logs mode reports it. */
export interface LogRow {
	readonly at: string;
	readonly severity: string;
	readonly body: string;
	readonly service: string;
	readonly traceId?: string;
	readonly spanId?: string;
	readonly attributes?: Readonly<Record<string, string>>;
}

/** The logs of one workflow, filtered and bounded like the trace list. */
export interface LogListResult {
	readonly owner: string;
	readonly logs: LogRow[];
	readonly matched: number;
	readonly truncated: boolean;
	readonly indexTruncated: boolean;
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

/** The OTLP span kinds, by number. */
const SPAN_KIND: Record<number, string> = {
	1: "internal",
	2: "server",
	3: "client",
	4: "producer",
	5: "consumer",
};

function kindOf(span: SpanData): string {
	return SPAN_KIND[span.kind] ?? "unspecified";
}

/** One span attribute, whatever the list shape that carries it. */
function attributeValue(
	attributes: readonly { key: string; value: string | number | boolean }[],
	key: string,
): string | undefined {
	const found = attributes.find((attribute) => attribute.key === key)?.value;
	return found === undefined ? undefined : String(found);
}

/**
 * Whether a trace is background traffic rather than a request.
 *
 * A poller that runs twice a second exports one span per query, so the newest
 * traces of a live backend were fifteen single-span `SELECT`s and the request
 * trace was invisible until it was filtered for by name
 * (`fix-env-tool-defects-from-e2e`). The rule is the span kind, not the SQL: a
 * trace of exactly one span that is not a `server` span is traffic the caller
 * did not ask for.
 */
function isBackgroundTrace(spans: readonly SpanData[]): boolean {
	if (spans.length !== 1) return false;
	const only = spans[0] as SpanData;
	return kindOf(only) !== "server";
}

/**
 * The HTTP identity strings one span offers a `http` filter: the method, every
 * route/target/url attribute (`http.route`, `http.target`, `http.url`,
 * `url.path`, `http.path`, `url.full`) and the span's own name — a
 * semantic-convention HTTP span is named `METHOD <route>`, so the name alone
 * matches `"POST /grid-allocation-api/v1/requests"`.
 *
 * The span name is included because a framework may name the server span after
 * the route while the route attribute sits on a child span, and the method is
 * prepended to each path so `"POST /path"` matches even when the span is named
 * after the route only.
 */
function httpIdentity(span: SpanData): string[] {
	const attributes = span.attributes ?? [];
	const method = (
		attributeValue(attributes, "http.request.method") ??
		attributeValue(attributes, "http.method") ??
		""
	).toLowerCase();
	const paths = [
		"http.route",
		"http.target",
		"http.url",
		"url.path",
		"url.full",
		"http.path",
	]
		.map((key) => attributeValue(attributes, key))
		.filter((entry): entry is string => entry !== undefined && entry !== "")
		.map((entry) => entry.toLowerCase());
	const identity = [...paths, span.name.toLowerCase()];
	if (method !== "")
		for (const path of paths) identity.push(`${method} ${path}`);
	return identity;
}

/** Whether any span of a trace carries an HTTP identity containing the filter
 * (a case-insensitive substring, with or without a leading `METHOD `). Matching
 * every span rather than the root only is deliberate: an instrumented server
 * may root a trace in a middleware span while the route lives one level down. */
function matchesHttp(spans: readonly SpanData[], filter: string): boolean {
	return spans.some((span) =>
		httpIdentity(span).some((identity) => identity.includes(filter)),
	);
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
		rootKind: kindOf(root),
	};
}

/** One trace as the list evaluates it: the spans the index holds, plus the
 * derived values the filters and the row share. */
interface TraceCandidate {
	readonly traceId: string;
	readonly spans: readonly SpanData[];
	row?: TraceRow;
	root?: SpanData;
	noise?: boolean;
	http?: boolean;
}

/**
 * The spans one workflow exported, newest traces first and bounded on every
 * axis. Nothing here is durable: it is the live view of what the receivers
 * decoded, so it holds for as long as this process does.
 */
export class TraceIndex {
	private readonly byOwner = new Map<string, Map<string, SpanData[]>>();
	/** Trace insertion order, so eviction is oldest-first within its class. */
	private readonly order: Array<{ owner: string; traceId: string }> = [];
	/** Traces this index dropped per owner, so an answer can say so. */
	private readonly evicted = new Map<string, number>();
	/** The ids this index dropped per owner, newest kept, so a span-tree lookup
	 * can answer "it was evicted" instead of "it never arrived". */
	private readonly evictedIds = new Map<string, string[]>();

	/** Index every span that names its owner. Returns how many were indexed. */
	push(spans: readonly SpanData[]): number {
		let indexed = 0;
		for (const span of spans) {
			const owner = resourceAttribute(span, AC_OWNER_ATTRIBUTE);
			if (owner === undefined || span.traceId === "") continue;
			const traceId = normalizeTraceId(span.traceId);
			let traces = this.byOwner.get(owner);
			if (!traces) {
				traces = new Map<string, SpanData[]>();
				this.byOwner.set(owner, traces);
			}
			let bucket = traces.get(traceId);
			if (!bucket) {
				bucket = [];
				traces.set(traceId, bucket);
				this.order.push({ owner, traceId });
			}
			bucket.push(span);
			if (bucket.length > MAX_INDEXED_SPANS_PER_TRACE)
				bucket.splice(0, bucket.length - MAX_INDEXED_SPANS_PER_TRACE);
			indexed++;
		}
		this.evict();
		return indexed;
	}

	/**
	 * Bound the retained traces the way the caller's own list is ordered: a
	 * single-span background trace (a poller's query) goes before a request
	 * trace, and the oldest trace of that class first.
	 *
	 * Insertion order alone was the defect behind a request trace that the list
	 * showed and the span-tree lookup could not find: a backend that polls its
	 * database twice a second produces ~120 single-span traces a minute, so the
	 * 200-trace window rolled over about every hundred seconds and the request
	 * trace — the one trace the caller asked about — was evicted while a hundred
	 * poller traces stayed.
	 */
	private evict(): void {
		while (this.order.length > MAX_INDEXED_TRACES) {
			const index = this.nextEviction();
			if (index < 0) return;
			const oldest = this.order.splice(index, 1)[0];
			if (!oldest) return;
			const traces = this.byOwner.get(oldest.owner);
			traces?.delete(oldest.traceId);
			if (traces && traces.size === 0) this.byOwner.delete(oldest.owner);
			this.evicted.set(oldest.owner, (this.evicted.get(oldest.owner) ?? 0) + 1);
			this.rememberEviction(oldest.owner, oldest.traceId);
		}
	}

	/** The insertion-order slot to evict: the oldest background trace this index
	 * holds, else the oldest trace of any kind. */
	private nextEviction(): number {
		for (let index = 0; index < this.order.length; index += 1) {
			const entry = this.order[index];
			if (!entry) continue;
			const spans = this.byOwner.get(entry.owner)?.get(entry.traceId);
			if (spans && isBackgroundTrace(spans)) return index;
		}
		return this.order.length > 0 ? 0 : -1;
	}

	private rememberEviction(owner: string, traceId: string): void {
		const ids = this.evictedIds.get(owner) ?? [];
		if (!ids.includes(traceId)) ids.push(traceId);
		if (ids.length > MAX_REMEMBERED_EVICTIONS)
			ids.splice(0, ids.length - MAX_REMEMBERED_EVICTIONS);
		this.evictedIds.set(owner, ids);
	}

	/** Whether this index received the trace and then dropped it (the retained
	 * traces bound), rather than never seeing it at all. */
	evictedTrace(owner: string, traceId: string): boolean {
		return (this.evictedIds.get(owner) ?? []).includes(
			normalizeTraceId(traceId),
		);
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
		const rootKind = query.rootKind?.trim().toLowerCase();
		const http = query.http?.trim().toLowerCase();
		const exclude = query.excludeNames?.trim().toLowerCase();
		const minSpans =
			query.minSpans === undefined || !Number.isFinite(query.minSpans)
				? undefined
				: Math.max(0, Math.floor(query.minSpans));
		const limit = boundLimit(query.limit);
		// The default noise ordering is a *default*: a caller that narrows the list
		// explicitly (a span count, an excluded name) did not ask for it.
		const ranked =
			query.includeNoise === true ||
			minSpans !== undefined ||
			exclude !== undefined;
		const candidates: TraceCandidate[] = [];
		for (const [traceId, spans] of this.byOwner.get(owner) ?? []) {
			if (spans.length === 0) continue;
			candidates.push({ traceId, spans });
		}
		const rowOf = (candidate: TraceCandidate): TraceRow =>
			(candidate.row ??= summarize(candidate.traceId, candidate.spans));
		const rootOfCandidate = (candidate: TraceCandidate): SpanData =>
			(candidate.root ??= rootOf(candidate.spans));
		const isNoise = (candidate: TraceCandidate): boolean =>
			(candidate.noise ??= isBackgroundTrace(candidate.spans));
		const httpMatches = (candidate: TraceCandidate): boolean =>
			(candidate.http ??= matchesHttp(candidate.spans, http ?? ""));
		// Every filter is one predicate, so the same evaluation both decides the
		// answer and counts what each filter removed on its own. A `matched: 0` is
		// then explainable instead of a bare zero.
		const filters: Array<{
			readonly name: string;
			readonly rejects: (candidate: TraceCandidate) => boolean;
		}> = [];
		if (app !== undefined && app !== "")
			filters.push({
				name: "app",
				rejects: (candidate) =>
					sharedAttribute(candidate.spans, AC_APP_ATTRIBUTE) !== app,
			});
		if (name !== undefined && name !== "")
			filters.push({
				name: "name",
				rejects: (candidate) =>
					!candidate.spans.some((span) =>
						span.name.toLowerCase().includes(name),
					),
			});
		if (minSpans !== undefined)
			filters.push({
				name: "minSpans",
				rejects: (candidate) => candidate.spans.length < minSpans,
			});
		if (exclude !== undefined && exclude !== "")
			filters.push({
				name: "excludeNames",
				// A poller's traces repeat one statement: a trace whose *every* span
				// names it is that poller's and nothing else.
				rejects: (candidate) =>
					candidate.spans.every((span) =>
						span.name.toLowerCase().includes(exclude),
					),
			});
		if (rootKind !== undefined && rootKind !== "")
			filters.push({
				name: "rootKind",
				rejects: (candidate) => kindOf(rootOfCandidate(candidate)) !== rootKind,
			});
		if (http !== undefined && http !== "")
			filters.push({
				name: "http",
				rejects: (candidate) => !httpMatches(candidate),
			});
		if (since !== undefined)
			filters.push({
				name: "since",
				rejects: (candidate) => Date.parse(rowOf(candidate).startedAt) < since,
			});
		if (query.status === "error")
			filters.push({
				name: "status",
				rejects: (candidate) => rowOf(candidate).status !== "error",
			});
		else if (query.status === "success")
			filters.push({
				name: "status",
				rejects: (candidate) => rowOf(candidate).status === "error",
			});
		const filtered: Record<string, number> = {};
		for (const filter of filters) filtered[filter.name] = 0;
		for (const candidate of candidates)
			for (const filter of filters)
				if (filter.rejects(candidate))
					filtered[filter.name] = (filtered[filter.name] ?? 0) + 1;
		const rows: TraceRow[] = [];
		const background = new Set<string>();
		for (const candidate of candidates) {
			if (filters.some((filter) => filter.rejects(candidate))) continue;
			if (!ranked && isNoise(candidate)) background.add(candidate.traceId);
			rows.push(rowOf(candidate));
		}
		rows.sort(
			(left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt),
		);
		// Request traces first, then the background traffic, each newest first: a
		// list whose newest rows are all pollers answers nothing.
		const ordered = ranked
			? rows
			: [
					...rows.filter((row) => !background.has(row.traceId)),
					...rows.filter((row) => background.has(row.traceId)),
				];
		const traces = ordered.slice(0, limit);
		const keptBackground = traces.filter((row) =>
			background.has(row.traceId),
		).length;
		const noiseDropped = background.size - keptBackground;
		const notices: string[] = [];
		if (noiseDropped > 0)
			notices.push(
				`${noiseDropped} of ${rows.length} matching traces are single-span background traffic (a poller's query, for example) and are ranked after the request traces; pass includeNoise: true, minSpans: 1 or excludeNames to rank or drop them yourself`,
			);
		if (rows.length === 0 && filters.length > 0)
			notices.push(
				`no trace of ${owner} passed every filter; of ${candidates.length} indexed traces each active filter rejected this many on its own — ${filters
					.map((filter) => `${filter.name} ${filtered[filter.name] ?? 0}`)
					.join(", ")}`,
			);
		return {
			owner,
			traces,
			matched: rows.length,
			truncated: ordered.length > limit,
			indexTruncated: (this.evicted.get(owner) ?? 0) > 0,
			noiseDropped,
			considered: candidates.length,
			filtered,
			...(notices.length > 0 ? { notice: notices.join(". ") } : {}),
		};
	}

	/**
	 * One trace's span tree, limited to the calling workflow's spans: a trace
	 * that also carries another workflow's spans answers with only this one's.
	 */
	tree(owner: string, traceId: string): TraceTreeResult | undefined {
		const key = normalizeTraceId(traceId);
		const spans = this.byOwner.get(owner)?.get(key);
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
			traceId: key,
			...(app === undefined ? {} : { app }),
			...(run === undefined ? {} : { run }),
			spans: roots.map((id) => nodes.get(id) as SpanNode),
			spanCount: kept.length,
			truncated: kept.length < spans.length,
		};
	}
}

/**
 * The live log index behind `otel_query`'s logs mode
 * (`fix-env-tool-defects-from-e2e`).
 *
 * The OTLP listener already decodes LOG records from the same `/v1/logs` the
 * shell's live stores read, and each record carries the same resource
 * attributes as a span — including `ac.owner`, which is what makes a record
 * attributable to one workflow. Before this index the records reached the
 * store and the tool answered spans only, so the log lines of one request
 * could not be fetched by its trace id even though the backend exported them.
 *
 * Every bound is the span index's: the retained records, the returned rows, the
 * characters one body and one attribute contribute.
 */
export class LogIndex {
	private readonly byOwner = new Map<string, LogData[]>();
	/** Records this index dropped per owner, so an answer can say so. */
	private readonly evicted = new Map<string, number>();

	/** Index every record that names its owner. Returns how many were indexed. */
	push(logs: readonly LogData[]): number {
		let indexed = 0;
		for (const log of logs) {
			const owner = resourceAttributeOf(log, AC_OWNER_ATTRIBUTE);
			if (owner === undefined) continue;
			const records = this.byOwner.get(owner) ?? [];
			records.push(log);
			if (records.length > MAX_INDEXED_LOGS) {
				const dropped = records.length - MAX_INDEXED_LOGS;
				records.splice(0, dropped);
				this.evicted.set(owner, (this.evicted.get(owner) ?? 0) + dropped);
			}
			this.byOwner.set(owner, records);
			indexed++;
		}
		return indexed;
	}

	/** Records this index holds for one owner. */
	size(owner: string): number {
		return this.byOwner.get(owner)?.length ?? 0;
	}

	/** The log records of one workflow, filtered and bounded. */
	list(owner: string, query: LogQuery = {}): LogListResult {
		const since =
			query.since === undefined ? undefined : Date.parse(query.since);
		if (since !== undefined && !Number.isFinite(since))
			throw new TraceIndexError(
				"invalid-since",
				`since must be an ISO 8601 instant, received ${JSON.stringify(query.since)}`,
			);
		const traceId = query.traceId?.trim().toLowerCase();
		const severity = query.severity?.trim().toUpperCase();
		const text = query.text?.trim().toLowerCase();
		const limit = boundLogLimit(query.limit);
		const rows: LogRow[] = [];
		for (const log of this.byOwner.get(owner) ?? []) {
			if (
				traceId !== undefined &&
				traceId !== "" &&
				(log.traceId ?? "").toLowerCase() !== traceId
			)
				continue;
			if (
				severity !== undefined &&
				severity !== "" &&
				!log.severity.toUpperCase().includes(severity)
			)
				continue;
			if (text !== undefined && text !== "") {
				const haystack = [
					log.body,
					log.severity,
					log.serviceName,
					...(log.attributes ?? []).map(
						(attribute) => `${attribute.key}=${String(attribute.value)}`,
					),
				]
					.join(" ")
					.toLowerCase();
				if (!haystack.includes(text)) continue;
			}
			const row = logRow(log);
			if (since !== undefined && Date.parse(row.at) < since) continue;
			rows.push(row);
		}
		rows.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
		return {
			owner,
			logs: rows.slice(0, limit),
			matched: rows.length,
			truncated: rows.length > limit,
			indexTruncated: (this.evicted.get(owner) ?? 0) > 0,
		};
	}
}

/** The resource attribute a log record carries, the way a span's is read. */
function resourceAttributeOf(log: LogData, key: string): string | undefined {
	const value = log.resource?.attributes?.find(
		(attribute) => attribute.key === key,
	)?.value;
	if (value === undefined) return undefined;
	const text = String(value);
	return text === "" ? undefined : text;
}

/** One record as the logs mode reports it: bounded body, bounded attributes. */
function logRow(log: LogData): LogRow {
	const attributes: Record<string, string> = {};
	for (const attribute of (log.attributes ?? []).slice(0, MAX_LOG_ATTRIBUTES))
		attributes[attribute.key] = truncate(
			String(attribute.value),
			MAX_ATTRIBUTE_CHARS,
		);
	return {
		at: instant(nanos(log.timeUnixNano)),
		severity: log.severity,
		body: truncate(log.body, MAX_LOG_BODY_CHARS),
		service: log.serviceName,
		...(log.traceId === undefined || log.traceId === ""
			? {}
			: { traceId: log.traceId }),
		...(log.spanId === undefined || log.spanId === ""
			? {}
			: { spanId: log.spanId }),
		...(Object.keys(attributes).length === 0 ? {} : { attributes }),
	};
}

/** The filters one logs query carries. */
export interface LogQuery {
	readonly traceId?: string;
	/** A severity substring, matched case-insensitively (`ERROR`, `WARN`). */
	readonly severity?: string;
	/** A substring any body, severity, service or attribute must contain. */
	readonly text?: string;
	readonly since?: string;
	readonly limit?: number;
}

function boundLogLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0)
		return DEFAULT_LOG_LIMIT;
	return Math.min(MAX_LOG_LIMIT, Math.floor(limit));
}
