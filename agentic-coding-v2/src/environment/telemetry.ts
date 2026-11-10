import { randomBytes, timingSafeEqual } from "node:crypto";
import { digest } from "../config.ts";
import { logSince } from "./log-timing.ts";
import type { TelemetryOptions } from "./model.ts";
import { TelemetryCertificate } from "./telemetry-certificate.ts";
import {
	decodeLogs,
	decodeSpans,
	type LogObservation,
	type SpanObservation,
} from "./telemetry-data.ts";
import { traceTree } from "./telemetry-tree.ts";

type Stored<T> = { row: T; bytes: number; sequence: number };
type Trace = {
	spans: Map<string, Stored<SpanObservation>>;
	bytes: number;
	capturedAt: number;
	sequence: number;
};
const limits = Object.freeze({
	traces: 200,
	evictedTraceIds: 200,
	spansPerTrace: 500,
	logs: 1000,
	traceBytes: 3 * 1024 * 1024,
	logBytes: 1024 * 1024,
	recordBytes: 16384,
	outputBytes: 49152,
});
/** One authenticated loopback receiver and data window per approved, live shell start.
 * Resource attributes are diagnostic input, never native attribution or authority. */
export class TelemetryCollector {
	readonly environment: Readonly<Record<string, string>>;
	readonly redact: (value: string) => string;
	private readonly server: Bun.Server<undefined>;
	private readonly traces = new Map<string, Trace>();
	private readonly logs: Stored<LogObservation>[] = [];
	private readonly evictedTraceIds = new Set<string>();
	private readonly pending = new Set<Promise<Response>>();
	private readonly readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
	private readonly scope: Readonly<{ app: string; owner: number; run: string }>;
	private traceBytes = 0;
	private logBytes = 0;
	private evictedTraces = 0;
	private droppedSpans = 0;
	private droppedLogs = 0;
	private sequence = 0;
	private readonly cursors = new Map<
		string,
		{ boundary: number; highWater: number; query: string; expires: number }
	>();
	private readonly certificate?: TelemetryCertificate;
	private readonly hidden: string[];
	private containerEndpoint = "";
	private authorization = "";
	private closed = false;
	private stopping: Promise<void> | null = null;
	constructor(
		scope: { app: string; owner: number; run: string },
		baseRedact: (value: string) => string,
		container?: { stateDir: string },
	) {
		this.scope = Object.freeze({ ...scope });
		const token = randomBytes(32).toString("hex"),
			authorization = `Bearer ${token}`;
		this.hidden = [
			Buffer.from(authorization).toString("base64"),
			Buffer.from(token).toString("base64"),
			token,
		];
		this.redact = (value) =>
			baseRedact(
				this.hidden.reduce(
					(result, secret) => result.replaceAll(secret, "[REDACTED]"),
					value,
				),
			);
		this.certificate = container
			? new TelemetryCertificate(container.stateDir)
			: undefined;
		this.authorization = authorization;
		this.server = (() => {
			try {
				return Bun.serve({
					hostname: container ? "0.0.0.0" : "127.0.0.1",
					...(this.certificate
						? {
								tls: {
									cert: this.certificate.certificate,
									key: this.certificate.key,
								},
							}
						: {}),
					port: 0,
					maxRequestBodySize: 65536,
					idleTimeout: 5,
					fetch: (request) => {
						if (this.pending.size >= 4)
							return new Response("Telemetry receiver is busy", {
								status: 429,
							});
						const operation = this.receive(request, authorization);
						this.pending.add(operation);
						void operation.then(
							() => this.pending.delete(operation),
							() => this.pending.delete(operation),
						);
						return operation;
					},
				});
			} catch {
				this.certificate?.close();
				throw new Error(
					"Native telemetry listener could not start; no receiver authority retained",
				);
			}
		})();
		const endpoint = `${container ? "https" : "http"}://127.0.0.1:${this.server.port}`;
		this.containerEndpoint = `https://host.docker.internal:${this.server.port}`;
		this.environment = Object.freeze({
			AC_OTEL_APP: scope.app,
			AC_OTEL_OWNER: String(scope.owner),
			AC_OTEL_RUN: scope.run,
			OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
			OTEL_EXPORTER_OTLP_HEADERS: `authorization=${encodeURIComponent(authorization)}`,
			OTEL_RESOURCE_ATTRIBUTES: `ac.app=${scope.app},ac.owner=${scope.owner},ac.run=${scope.run}`,
			OTEL_METRICS_EXPORTER: "none",
		});
	}
	includeRedactions(values: readonly string[]) {
		this.hidden.push(
			...values.filter((value) => value && !this.hidden.includes(value)),
		);
		this.hidden.sort((a, b) => b.length - a.length);
	}
	certificateMount() {
		if (this.closed || !this.certificate)
			throw new Error("No original live native TLS telemetry certificate");
		return this.certificate.mount();
	}
	containerEnvironment() {
		this.certificateMount();
		return {
			OTEL_COLLECTOR_CONFIG: JSON.stringify({
				receivers: {
					otlp: {
						protocols: {
							grpc: { endpoint: "0.0.0.0:4317" },
							http: { endpoint: "0.0.0.0:4318" },
						},
					},
				},
				processors: {
					batch: {
						send_batch_size: 16,
						send_batch_max_size: 16,
						timeout: "1s",
					},
				},
				exporters: {
					otlp_http: {
						endpoint: this.containerEndpoint,
						encoding: "json",
						compression: "none",
						headers: { Authorization: this.authorization },
						tls: { ca_file: "/acv2-otel-ca.pem" },
						sending_queue: { enabled: false },
						retry_on_failure: { enabled: false },
						timeout: "5s",
					},
					debug: { verbosity: "basic" },
				},
				service: {
					telemetry: { logs: { level: "info" } },
					pipelines: Object.fromEntries(
						["traces", "logs"].map((mode) => [
							mode,
							{
								receivers: ["otlp"],
								processors: ["batch"],
								exporters: ["otlp_http", "debug"],
							},
						]),
					),
				},
			}),
		};
	}
	private async body(request: Request): Promise<unknown> {
		if (!request.body) throw new Error("Missing telemetry body");
		const reader = request.body.getReader(),
			decoder = new TextDecoder("utf-8", { fatal: true });
		this.readers.add(reader);
		let bytes = 0,
			text = "",
			expired = false;
		const timer = setTimeout(() => {
			expired = true;
			void reader.cancel().catch(() => {});
		}, 5000);
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > 65536) throw new Error("Telemetry body exceeds bound");
				text += decoder.decode(chunk.value, { stream: true });
			}
			if (expired || this.closed) throw new Error("Telemetry reception ended");
			return JSON.parse(text + decoder.decode());
		} finally {
			clearTimeout(timer);
			this.readers.delete(reader);
			reader.releaseLock();
		}
	}
	private async receive(
		request: Request,
		authorization: string,
	): Promise<Response> {
		try {
			const url = new URL(request.url);
			if (this.closed) return new Response(null, { status: 410 });
			if (
				!(
					url.hostname === "127.0.0.1" ||
					(this.certificate && url.hostname === "host.docker.internal")
				) ||
				url.port !== String(this.server.port) ||
				url.protocol !== (this.certificate ? "https:" : "http:")
			)
				return new Response(null, { status: 403 });
			const supplied = request.headers.get("authorization") ?? "";
			if (
				Buffer.byteLength(supplied) !== Buffer.byteLength(authorization) ||
				!timingSafeEqual(Buffer.from(supplied), Buffer.from(authorization))
			)
				return new Response(null, { status: 401 });
			if (
				request.method !== "POST" ||
				!["/v1/traces", "/v1/logs"].includes(url.pathname) ||
				url.search
			)
				return new Response(null, { status: 404 });
			if (
				(request.headers.get("content-type") ?? "").split(";")[0].trim() !==
					"application/json" ||
				![null, "identity"].includes(request.headers.get("content-encoding"))
			)
				return new Response(null, { status: 415 });
			const payload = await this.body(request);
			if (this.closed) return new Response(null, { status: 410 });
			let rejected = 0;
			if (url.pathname === "/v1/traces")
				for (const span of decodeSpans(payload, this.redact, Date.now())) {
					if (!this.captureSpan(span)) rejected++;
				}
			else
				for (const log of decodeLogs(payload, this.redact, Date.now())) {
					if (!this.captureLog(log)) rejected++;
				}
			return Response.json(
				rejected
					? {
							partialSuccess: {
								[url.pathname === "/v1/traces"
									? "rejectedSpans"
									: "rejectedLogRecords"]: String(rejected),
								errorMessage: "Records exceeded the bounded capture window",
							},
						}
					: {},
			);
		} catch {
			return Response.json(
				{
					error: "Malformed, expired or unsupported bounded OTLP JSON payload",
				},
				{ status: 400 },
			);
		}
	}
	private captureSpan(row: SpanObservation) {
		const encoded = JSON.stringify(row),
			bytes = Buffer.byteLength(encoded);
		if (bytes > limits.recordBytes || this.redact(encoded) !== encoded) {
			this.droppedSpans++;
			return false;
		}
		const trace = this.traces.get(row.traceId) ?? {
			spans: new Map<string, Stored<SpanObservation>>(),
			bytes: 0,
			capturedAt: row.capturedAt,
			sequence: 0,
		};
		const prior = trace.spans.get(row.spanId);
		if (prior) {
			trace.bytes -= prior.bytes;
			this.traceBytes -= prior.bytes;
			trace.spans.delete(row.spanId);
		}
		trace.spans.set(row.spanId, { row, bytes, sequence: ++this.sequence });
		trace.sequence = this.sequence;
		trace.bytes += bytes;
		trace.capturedAt = row.capturedAt;
		this.traceBytes += bytes;
		while (trace.spans.size > limits.spansPerTrace) {
			const first = trace.spans.entries().next().value;
			if (!first) break;
			trace.spans.delete(first[0]);
			trace.bytes -= first[1].bytes;
			this.traceBytes -= first[1].bytes;
			this.droppedSpans++;
		}
		this.traces.delete(row.traceId);
		this.evictedTraceIds.delete(row.traceId);
		this.traces.set(row.traceId, trace);
		while (
			this.traces.size > limits.traces ||
			this.traceBytes > limits.traceBytes
		) {
			const first = this.traces.entries().next().value;
			if (!first) break;
			this.traces.delete(first[0]);
			this.traceBytes -= first[1].bytes;
			this.evictedTraces++;
			this.evictedTraceIds.delete(first[0]);
			this.evictedTraceIds.add(first[0]);
			while (this.evictedTraceIds.size > limits.evictedTraceIds) {
				const oldest = this.evictedTraceIds.values().next().value;
				if (!oldest) break;
				this.evictedTraceIds.delete(oldest);
			}
		}
		return true;
	}
	private captureLog(row: LogObservation) {
		const encoded = JSON.stringify(row),
			bytes = Buffer.byteLength(encoded);
		if (bytes > limits.recordBytes || this.redact(encoded) !== encoded) {
			this.droppedLogs++;
			return false;
		}
		this.logs.push({ row, bytes, sequence: ++this.sequence });
		this.logBytes += bytes;
		while (this.logs.length > limits.logs || this.logBytes > limits.logBytes) {
			const first = this.logs.shift();
			if (!first) break;
			this.logBytes -= first.bytes;
			this.droppedLogs++;
		}
		return true;
	}
	private traceAvailability(id: string, mode: string) {
		if (mode === "logs")
			return this.logs.some((entry) => entry.row.traceId === id)
				? "retained"
				: "not-retained";
		if (this.traces.has(id)) return "retained";
		return this.evictedTraceIds.has(id) ? "evicted" : "unknown";
	}
	query(options: TelemetryOptions) {
		const allowed = new Set([
			"mode",
			"view",
			"cursor",
			"traceId",
			"spanId",
			"http",
			"service",
			"rootKind",
			"limit",
			"since",
			"status",
			"name",
			"severity",
			"text",
		]);
		if (Object.keys(options).some((key) => !allowed.has(key)))
			throw new Error("Unknown native telemetry query option");
		if (this.closed)
			throw new Error(
				"Native telemetry capture is closed; saved data cannot restore a held run",
			);
		const mode = options.mode ?? "traces",
			limit = options.limit ?? 20,
			status = options.status ?? "all",
			since = logSince(options.since);
		if (
			!["traces", "logs"].includes(mode) ||
			(options.view !== undefined &&
				options.view !== "flat" &&
				options.view !== "tree") ||
			(options.cursor !== undefined &&
				(typeof options.cursor !== "string" ||
					!/^[a-f0-9]{64}$/.test(options.cursor))) ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 200 ||
			!["all", "error", "success"].includes(status) ||
			[options.name, options.text, options.http, options.service].some(
				(value) =>
					value !== undefined &&
					(typeof value !== "string" || value.length > 512),
			) ||
			(options.severity !== undefined &&
				(typeof options.severity !== "string" ||
					options.severity.length > 64)) ||
			(options.spanId !== undefined &&
				(!options.traceId ||
					!/^[a-f0-9]{16}$/i.test(options.spanId) ||
					this.redact(options.spanId) !== options.spanId)) ||
			(options.rootKind !== undefined &&
				![
					"unspecified",
					"internal",
					"server",
					"client",
					"producer",
					"consumer",
				].includes(options.rootKind)) ||
			(options.traceId !== undefined &&
				(!/^[a-f0-9]{32}$/i.test(options.traceId) ||
					this.redact(options.traceId) !== options.traceId))
		)
			throw new Error("Invalid bounded native telemetry query");
		if (
			(options.view === "tree" && (mode !== "traces" || !options.traceId)) ||
			(mode === "logs" &&
				(options.view !== undefined ||
					options.http !== undefined ||
					options.rootKind !== undefined ||
					options.status !== undefined ||
					options.name !== undefined)) ||
			(mode === "traces" &&
				(options.severity !== undefined || options.text !== undefined))
		)
			throw new Error("Telemetry filter does not apply to the selected mode");
		const after = (time: number) =>
			!since || BigInt(time) * 1000000n >= since.epochNanoseconds;
		const base = {
			source: "native-run-otlp-http-json",
			scope: { ...this.scope },
			mode,
			timeBasis: "host-receipt",
			since: since?.toString() ?? null,
			completeness: "retained-observations-only",
			limits,
			loss: {
				evictedTraces: this.evictedTraces,
				evictedTraceIdsRetained: this.evictedTraceIds.size,
				droppedSpans: this.droppedSpans,
				droppedLogs: this.droppedLogs,
			},
		};
		const fingerprint = digest(
			JSON.stringify([
				mode,
				options.view ?? "flat",
				options.traceId?.toLowerCase() ?? null,
				since?.toString() ?? null,
				status,
				options.name ?? null,
				options.severity ?? null,
				options.text ?? null,
				options.spanId?.toLowerCase() ?? null,
				options.http ?? null,
				options.service ?? null,
				options.rootKind ?? null,
			]),
		);
		for (const [id, cursor] of this.cursors)
			if (cursor.expires < Date.now()) this.cursors.delete(id);
		const cursor = options.cursor
			? this.cursors.get(options.cursor)
			: undefined;
		if (options.cursor && (!cursor || cursor.query !== fingerprint))
			throw new Error(
				"Unknown or expired telemetry cursor for this exact run and query; reload newest history",
			);
		const highWater = cursor?.highWater ?? this.sequence;
		const includes = (value: string, filter: string | undefined) =>
			!filter || value.toLowerCase().includes(filter.toLowerCase());
		const spanMatches = (span: SpanObservation) =>
			(!options.spanId || span.spanId === options.spanId.toLowerCase()) &&
			includes(span.service, options.service) &&
			includes(
				[
					span.name,
					...[
						"http.request.method",
						"http.method",
						"http.route",
						"http.target",
						"url.full",
						"http.url",
					]
						.map((key) => span.attributes[key] ?? "")
						.filter((value) =>
							typeof value === "string" ? value.length > 0 : true,
						),
				].join(" "),
				options.http,
			);

		type Candidate = { row: Record<string, unknown>; sequence: number };
		let rows: Candidate[] = [],
			structure: ReturnType<typeof traceTree>["structure"] | undefined;
		if (mode === "logs")
			rows = this.logs
				.toReversed()
				.filter((entry) => entry.sequence <= highWater)
				.filter(
					({ row }) =>
						after(row.capturedAt) &&
						(!options.spanId || row.spanId === options.spanId.toLowerCase()) &&
						includes(row.service, options.service) &&
						(!options.traceId ||
							row.traceId === options.traceId.toLowerCase()) &&
						(!options.severity ||
							row.severity
								.toLowerCase()
								.includes(options.severity.toLowerCase())) &&
						(!options.text || JSON.stringify(row).includes(options.text)),
				)
				.map((entry) => ({ row: entry.row, sequence: entry.sequence }));
		else if (options.traceId) {
			const trace = this.traces.get(options.traceId.toLowerCase()),
				entries = [...(trace?.spans.values() ?? [])].filter(
					(entry) => entry.sequence <= highWater,
				),
				sequences = new Map(
					entries.map((entry) => [entry.row.spanId, entry.sequence]),
				);
			let spans: SpanObservation[] = entries.map((entry) => entry.row);
			if (options.view === "tree") {
				const tree = traceTree(spans);
				spans = tree.ordered;
				structure = tree.structure;
			}
			rows = spans
				.filter(
					(row) =>
						after(row.capturedAt) &&
						spanMatches(row) &&
						(!options.rootKind || row.kind === options.rootKind) &&
						(!options.name ||
							row.name.toLowerCase().includes(options.name.toLowerCase())) &&
						(status === "all" ||
							(status === "error") === (row.status === "error")),
				)
				.map((row) => ({ row, sequence: sequences.get(row.spanId) ?? 0 }));
		} else
			rows = [...this.traces.entries()]
				.toReversed()
				.filter(([, trace]) => trace.sequence <= highWater)
				.map(([traceId, trace]) => {
					const spans = [...trace.spans.values()].map((entry) => entry.row),
						root = spans.find((span) => span.parentSpanId === null) ?? spans[0],
						starts = spans.map((span) => BigInt(span.startTime)),
						ends = spans.map((span) => BigInt(span.endTime)),
						// biome-ignore lint/complexity/useMathMinMax: Math.min does not accept bigint nanoseconds.
						start = starts.reduce((a, b) => (a < b ? a : b), starts[0] ?? 0n),
						// biome-ignore lint/complexity/useMathMinMax: Math.max does not accept bigint nanoseconds.
						end = ends.reduce((a, b) => (a > b ? a : b), ends[0] ?? 0n);
					return {
						sequence: trace.sequence,
						matches: spans.some(spanMatches),
						row: {
							traceId,
							root: root?.name ?? "not-reported",
							rootKind: root?.kind ?? "unspecified",
							rootBasis: spans.some((span) => span.parentSpanId === null)
								? "reported-parentless-span"
								: "retained-span-fallback",
							services: [...new Set(spans.map((span) => span.service))]
								.sort()
								.slice(0, 16),
							servicesOmitted: Math.max(
								0,
								new Set(spans.map((span) => span.service)).size - 16,
							),
							eventCount: spans.reduce(
								(count, span) => count + span.events.length,
								0,
							),
							linkCount: spans.reduce(
								(count, span) => count + span.links.length,
								0,
							),
							spanCount: spans.length,
							errorCount: spans.filter((span) => span.status === "error")
								.length,
							durationMs: Number(end - start) / 1000000,
							startTime: start.toString(),
							endTime: end.toString(),
							capturedAt: trace.capturedAt,
						},
					};
				})
				.filter(
					({ row, matches }) =>
						matches &&
						(!options.rootKind || row.rootKind === options.rootKind) &&
						after(row.capturedAt) &&
						(!options.name ||
							row.root.toLowerCase().includes(options.name.toLowerCase())) &&
						(status === "all" || (status === "error") === row.errorCount > 0),
				);
		const start = cursor
			? rows.findIndex((entry) => entry.sequence === cursor.boundary) + 1
			: 0;
		if (cursor && start === 0)
			throw new Error(
				"Telemetry cursor boundary was evicted or replaced; reload newest history",
			);
		const selected: Record<string, unknown>[] = [];
		let remaining =
				limits.outputBytes - Buffer.byteLength(JSON.stringify(structure ?? {})),
			end = start;
		for (const entry of rows.slice(start, start + limit)) {
			const cost = Buffer.byteLength(JSON.stringify(entry.row)) + 2;
			if (cost > remaining) break;
			remaining -= cost;
			selected.push(structuredClone(entry.row));
			end++;
		}
		let nextCursor: string | null = null;
		const boundary = rows[end - 1];
		if (end < rows.length && boundary && end > start) {
			nextCursor = randomBytes(32).toString("hex");
			this.cursors.set(nextCursor, {
				boundary: boundary.sequence,
				highWater,
				query: fingerprint,
				expires: Date.now() + 300000,
			});
			while (this.cursors.size > 200) {
				const oldest = this.cursors.keys().next().value;
				if (!oldest) break;
				this.cursors.delete(oldest);
			}
		}
		return {
			...base,
			...(options.traceId
				? {
						traceId: options.traceId.toLowerCase(),
						availability: this.traceAvailability(
							options.traceId.toLowerCase(),
							mode,
						),
						availabilityBasis:
							mode === "logs"
								? "unfiltered-retained-log-window"
								: "unfiltered-trace-and-bounded-eviction-identity-windows",
						unknownMeaning:
							mode === "logs"
								? "No linked logs in the retained window; this does not establish whether linked logs ever existed"
								: "Never captured, not retained, or older than the bounded eviction-identity window; not proof that the trace never existed",
					}
				: {}),
			representation:
				mode === "logs"
					? "log-records"
					: options.traceId
						? options.view === "tree"
							? "trace-tree-preorder-nodes"
							: "flat-spans-with-parent-ids"
						: "trace-summaries",
			...(structure ? { tree: structure } : {}),
			records: selected,
			nextCursor,
			paging: {
				remainingOlder: rows.length - end,
				pageOffset: start,
				authority:
					"Five-minute, bounded, exact-run/query cursors select retained observations only; not frozen snapshots or execution authority. New captures are excluded; evicted/replaced boundaries refuse. Reload newest to see updates.",
			},
			selection: {
				matchedRetainedRecords: rows.length,
				returnedRecords: selected.length,
				limitOmitted: Math.max(0, rows.length - start - limit),
				budgetOmitted: Math.min(rows.length - start, limit) - selected.length,
			},
		};
	}
	close(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.closed = true;
		this.traces.clear();
		this.cursors.clear();
		this.evictedTraceIds.clear();
		this.logs.length = 0;
		this.traceBytes = 0;
		this.logBytes = 0;
		for (const reader of this.readers) void reader.cancel().catch(() => {});
		this.stopping = (async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					(async () => {
						await this.server.stop(true);
						await Promise.allSettled([...this.pending]);
					})(),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() =>
								reject(new Error("Native telemetry cleanup did not settle")),
							2000,
						);
						timer.unref();
					}),
				]);
				this.certificate?.close();
			} finally {
				if (timer) clearTimeout(timer);
			}
		})();
		return this.stopping;
	}
}
