import { randomBytes, timingSafeEqual } from "node:crypto";
import { logSince } from "./log-timing.ts";
import type { TelemetryOptions } from "./model.ts";
import {
	decodeLogs,
	decodeSpans,
	type LogObservation,
	type SpanObservation,
} from "./telemetry-data.ts";

type Stored<T> = { row: T; bytes: number };
type Trace = {
	spans: Map<string, Stored<SpanObservation>>;
	bytes: number;
	capturedAt: number;
};
const limits = Object.freeze({
	traces: 200,
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
	private readonly pending = new Set<Promise<Response>>();
	private readonly readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
	private readonly scope: Readonly<{ app: string; owner: number; run: string }>;
	private traceBytes = 0;
	private logBytes = 0;
	private evictedTraces = 0;
	private droppedSpans = 0;
	private droppedLogs = 0;
	private closed = false;
	private stopping: Promise<void> | null = null;
	constructor(
		scope: { app: string; owner: number; run: string },
		baseRedact: (value: string) => string,
	) {
		this.scope = Object.freeze({ ...scope });
		const token = randomBytes(32).toString("hex"),
			authorization = `Bearer ${token}`;
		const hidden = [
			Buffer.from(authorization).toString("base64"),
			Buffer.from(token).toString("base64"),
			token,
		];
		this.redact = (value) =>
			baseRedact(
				hidden.reduce(
					(result, secret) => result.replaceAll(secret, "[REDACTED]"),
					value,
				),
			);
		this.server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			maxRequestBodySize: 65536,
			idleTimeout: 5,
			fetch: (request) => {
				if (this.pending.size >= 4)
					return new Response("Telemetry receiver is busy", { status: 429 });
				const operation = this.receive(request, authorization);
				this.pending.add(operation);
				void operation.then(
					() => this.pending.delete(operation),
					() => this.pending.delete(operation),
				);
				return operation;
			},
		});
		const endpoint = `http://127.0.0.1:${this.server.port}`;
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
			if (url.hostname !== "127.0.0.1" || url.port !== String(this.server.port))
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
		};
		const prior = trace.spans.get(row.spanId);
		if (prior) {
			trace.bytes -= prior.bytes;
			this.traceBytes -= prior.bytes;
			trace.spans.delete(row.spanId);
		}
		trace.spans.set(row.spanId, { row, bytes });
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
		this.logs.push({ row, bytes });
		this.logBytes += bytes;
		while (this.logs.length > limits.logs || this.logBytes > limits.logBytes) {
			const first = this.logs.shift();
			if (!first) break;
			this.logBytes -= first.bytes;
			this.droppedLogs++;
		}
		return true;
	}
	query(options: TelemetryOptions) {
		const allowed = new Set([
			"mode",
			"traceId",
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
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 200 ||
			!["all", "error", "success"].includes(status) ||
			[options.name, options.text].some(
				(value) =>
					value !== undefined &&
					(typeof value !== "string" || value.length > 512),
			) ||
			(options.severity !== undefined &&
				(typeof options.severity !== "string" ||
					options.severity.length > 64)) ||
			(options.traceId !== undefined &&
				(!/^[a-f0-9]{32}$/i.test(options.traceId) ||
					this.redact(options.traceId) !== options.traceId))
		)
			throw new Error("Invalid bounded native telemetry query");
		if (
			(mode === "logs" &&
				(options.status !== undefined || options.name !== undefined)) ||
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
				droppedSpans: this.droppedSpans,
				droppedLogs: this.droppedLogs,
			},
		};
		let rows: unknown[] = [];
		if (mode === "logs")
			rows = this.logs
				.toReversed()
				.map((entry) => entry.row)
				.filter(
					(row) =>
						after(row.capturedAt) &&
						(!options.traceId ||
							row.traceId === options.traceId.toLowerCase()) &&
						(!options.severity ||
							row.severity
								.toLowerCase()
								.includes(options.severity.toLowerCase())) &&
						(!options.text || JSON.stringify(row).includes(options.text)),
				);
		else if (options.traceId) {
			const trace = this.traces.get(options.traceId.toLowerCase());
			rows = trace
				? [...trace.spans.values()]
						.map((entry) => entry.row)
						.filter(
							(row) =>
								after(row.capturedAt) &&
								(!options.name ||
									row.name
										.toLowerCase()
										.includes(options.name.toLowerCase())) &&
								(status === "all" ||
									(status === "error") === (row.status === "error")),
						)
				: [];
		} else
			rows = [...this.traces.entries()]
				.toReversed()
				.map(([traceId, trace]) => {
					const spans = [...trace.spans.values()].map((entry) => entry.row),
						root = spans.find((span) => span.parentSpanId === null) ?? spans[0];
					return {
						traceId,
						root: root?.name ?? "not-reported",
						rootKind: root?.kind ?? "unspecified",
						spanCount: spans.length,
						errorCount: spans.filter((span) => span.status === "error").length,
						capturedAt: trace.capturedAt,
					};
				})
				.filter(
					(row) =>
						after(row.capturedAt) &&
						(!options.name ||
							row.root.toLowerCase().includes(options.name.toLowerCase())) &&
						(status === "all" || (status === "error") === row.errorCount > 0),
				);
		const selected: unknown[] = [];
		let remaining = limits.outputBytes;
		for (const row of rows.slice(0, limit)) {
			const cost = Buffer.byteLength(JSON.stringify(row)) + 2;
			if (cost > remaining) continue;
			remaining -= cost;
			selected.push(structuredClone(row));
		}
		return {
			...base,
			...(options.traceId
				? {
						traceId: options.traceId.toLowerCase(),
						availability: rows.length ? "retained" : "not-retained",
					}
				: {}),
			representation:
				mode === "logs"
					? "log-records"
					: options.traceId
						? "flat-spans-with-parent-ids"
						: "trace-summaries",
			records: selected,
			selection: {
				matchedRetainedRecords: rows.length,
				returnedRecords: selected.length,
				limitOmitted: Math.max(0, rows.length - limit),
				budgetOmitted: Math.min(rows.length, limit) - selected.length,
			},
		};
	}
	close(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.closed = true;
		this.traces.clear();
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
			} finally {
				if (timer) clearTimeout(timer);
			}
		})();
		return this.stopping;
	}
}
