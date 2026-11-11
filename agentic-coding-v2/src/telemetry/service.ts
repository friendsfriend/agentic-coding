// v1 receiver/storage composition, owned by the v2 runtime. Receiver input is
// data, never native task/lease authority. Reads share the authenticated host.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { equalSecret } from "../server/auth.ts";
import { Refusal } from "../server/refusal.ts";
import type {
	LogData,
	MetricData,
	SpanData,
	TelemetryReceiverState,
} from "./contracts.ts";
import { routeReceiverRequest, type SignalRouter } from "./receivers/index.ts";
import { MetricCollectors } from "./receivers/metric-collectors.ts";
import {
	type OwnedGrpcReceiver,
	startOtlpGrpcReceiver,
} from "./receivers/otlp-grpc.ts";
import { TraceDb } from "./telemetry-db.ts";

// Receiver records are untrusted even when the exporter is authenticated.
// Reject invalid/overflowing timestamps and non-renderable scalar fields before
// SQLite or a view sees them. Never persist a partially validated batch.
const validNanos = (value: unknown) =>
	typeof value === "string" &&
	/^\d{1,19}$/.test(value) &&
	BigInt(value) <= 9223372036854775807n;
const validText = (value: unknown) => typeof value === "string";
function assertSpans(spans: SpanData[]) {
	for (const span of spans)
		if (
			!validNanos(span.startTimeUnixNano) ||
			!validNanos(span.endTimeUnixNano) ||
			!validText(span.name) ||
			!validText(span.serviceName) ||
			!Number.isFinite(span.status.code)
		)
			throw new Error("Invalid trace record");
}
const validAttributes = (value: unknown) =>
	Array.isArray(value) &&
	value.every(
		(item) =>
			item &&
			typeof item === "object" &&
			typeof item.key === "string" &&
			typeof item.value === "string",
	);
function assertMetrics(metrics: MetricData[]) {
	for (const metric of metrics)
		if (
			!validText(metric.name) ||
			!validText(metric.serviceName) ||
			!validText(metric.unit) ||
			!validText(metric.description) ||
			!["gauge", "sum", "histogram"].includes(metric.type) ||
			!validText(metric.scope?.name) ||
			!validText(metric.scope?.version) ||
			!validAttributes(metric.resource?.attributes) ||
			!Array.isArray(metric.dataPoints) ||
			metric.dataPoints.some(
				(point) =>
					!validNanos(point.timeUnixNano) ||
					!validNanos(point.startTimeUnixNano) ||
					!Number.isFinite(point.value) ||
					!validAttributes(point.attributes) ||
					point.bucketCounts?.some((count) => !Number.isFinite(count)) ||
					point.explicitBounds?.some((bound) => !Number.isFinite(bound)),
			)
		)
			throw new Error("Invalid metric record");
}
function assertLogs(logs: LogData[]) {
	for (const log of logs)
		if (
			!validNanos(log.timeUnixNano) ||
			!validText(log.body) ||
			!validText(log.severity) ||
			!validText(log.serviceName)
		)
			throw new Error("Invalid log record");
}

export class Telemetry {
	readonly db: TraceDb;
	readonly collectors: MetricCollectors;
	revision = 0;
	private readonly router: SignalRouter;
	private readonly watchers = new Map<string, () => void>();
	private closed = false;
	private scans = 0;
	private receiver?: OwnedGrpcReceiver;
	private receiverWork?: Promise<void>;
	private receiverState: TelemetryReceiverState = {
		revision: 0,
		status: "stopped",
		protocol: "otlp-grpc-traces",
		address: null,
		credentialFile: null,
	};
	receiverStatus(): TelemetryReceiverState {
		return { ...this.receiverState };
	}
	async controlReceiver(
		operation: "start" | "stop",
		revision: number,
		port = 0,
	): Promise<TelemetryReceiverState> {
		if (this.closed || this.receiverWork)
			throw new Refusal(
				"Telemetry receiver transition is unavailable; refresh its state",
			);
		if (this.receiverState.revision !== revision)
			throw new Refusal(
				"Telemetry receiver revision changed; refresh its state",
			);
		if (operation === "start" && this.receiver)
			throw new Refusal("Telemetry receiver is already running");
		if (operation === "stop" && !this.receiver)
			throw new Refusal("Telemetry receiver is already stopped");
		if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
			throw new Refusal("Invalid telemetry receiver port");
		this.receiverState = {
			...this.receiverState,
			revision: revision + 1,
			status: operation === "start" ? "starting" : "stopping",
		};
		const work = (async () => {
			if (operation === "stop") {
				await this.stopReceiver();
				return;
			}
			const token = randomBytes(32).toString("hex");
			const file = join(this.directory, `grpc-${randomUUID()}.token`);
			try {
				writeFileSync(file, token, { mode: 0o600, flag: "wx" });
				const receiver = await startOtlpGrpcReceiver(
					port,
					this.router,
					(values) =>
						values.length === 1 &&
						typeof values[0] === "string" &&
						equalSecret(values[0], `Bearer ${token}`),
				);
				this.receiver = receiver;
				this.receiverState = {
					...this.receiverState,
					status: "running",
					address: receiver.address,
					credentialFile: file,
				};
			} catch {
				try {
					unlinkSync(file);
				} catch {}
				this.receiverState = {
					...this.receiverState,
					status: "stopped",
					address: null,
					credentialFile: null,
				};
				throw new Refusal(
					"Telemetry receiver could not start; check the selected port and refresh",
				);
			}
		})();
		this.receiverWork = work;
		try {
			await work;
			return this.receiverStatus();
		} finally {
			this.receiverWork = undefined;
		}
	}
	private async stopReceiver() {
		await this.receiver?.stop();
		this.receiver = undefined;
		const file = this.receiverState.credentialFile;
		if (file) {
			try {
				unlinkSync(file);
			} catch {}
		}
		this.receiverState = {
			...this.receiverState,
			status: "stopped",
			address: null,
			credentialFile: null,
		};
	}
	async scan(repository: string) {
		if (this.closed) throw new Error("Telemetry service is closed");
		this.scans++;
		try {
			const scanned = await this.db.scanAllWorkspacesAsync(repository);
			if (!this.closed && scanned) this.revision++;
			return scanned;
		} finally {
			this.scans--;
		}
	}
	watch(repository: string) {
		if (this.closed) throw new Error("Telemetry service is closed");
		if (!this.watchers.has(repository))
			this.watchers.set(
				repository,
				this.db.watchWorkspaces(repository, () => {
					if (!this.closed) this.revision++;
				}),
			);
	}
	unwatch(repository: string) {
		this.watchers.get(repository)?.();
		this.watchers.delete(repository);
	}
	prune(days: number) {
		const removed = this.db.cleanupOlderThan(days);
		this.revision++;
		return removed;
	}
	constructor(private readonly directory: string) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		this.db = new TraceDb(directory);
		chmodSync(directory, 0o700);
		chmodSync(join(directory, "traces.sqlite"), 0o600);
		this.router = {
			pushTraces: (spans) => {
				assertSpans(spans);
				for (const span of spans) {
					const workspace = span.attributes.find(
						(attribute) => attribute.key === "herdr.change.id",
					)?.value;
					this.db.ingestSpan(
						typeof workspace === "string" &&
							workspace.length > 0 &&
							workspace.length <= 256
							? workspace
							: span.traceId,
						span,
					);
				}
				if (spans.length) this.revision++;
			},
			pushMetrics: (metrics) => {
				assertMetrics(metrics);
				for (const metric of metrics)
					this.db.ingestMetrics(metric.serviceName || "unknown", [metric]);
				if (metrics.length) this.revision++;
			},
			pushLogs: (logs) => {
				assertLogs(logs);
				for (const log of logs)
					this.db.ingestLogs(log.serviceName || "unknown", [log]);
				if (logs.length) this.revision++;
			},
		};
		this.collectors = new MetricCollectors((metrics) =>
			this.router.pushMetrics(metrics),
		);
	}
	async route(request: Request, url: URL): Promise<Response | null> {
		const received = routeReceiverRequest(request, this.router);
		if (received) return received;
		if (!url.pathname.startsWith("/api/telemetry/")) return null;
		if (request.method !== "GET") return new Response(null, { status: 405 });
		const query = url.searchParams;
		const allowed = url.pathname.endsWith("/traces")
			? ["page", "perPage", "changeId"]
			: url.pathname.endsWith("/spans")
				? ["limit", "changeId"]
				: url.pathname.endsWith("/metrics") || url.pathname.endsWith("/logs")
					? ["changeId"]
					: [];
		for (const key of query.keys())
			if (!allowed.includes(key) || query.getAll(key).length !== 1)
				return Response.json(
					{ error: "Unknown or repeated telemetry query" },
					{ status: 400 },
				);
		if (
			query.has("changeId") &&
			(!query.get("changeId") || (query.get("changeId")?.length ?? 0) > 256)
		)
			return Response.json(
				{ error: "Invalid telemetry identity" },
				{ status: 400 },
			);
		const integer = (name: string, fallback: number, max: number) => {
			const raw = query.get(name);
			if (raw === null) return fallback;
			if (!/^\d+$/.test(raw)) throw new Error("Invalid telemetry page");
			const value = Number(raw);
			if (!Number.isSafeInteger(value) || value < 1 || value > max)
				throw new Error("Invalid telemetry page");
			return value;
		};
		try {
			let result: unknown;
			switch (url.pathname) {
				case "/api/telemetry/traces":
					result = this.db.listTraceSummaries({
						page: integer("page", 1, 1_000_000),
						perPage: integer("perPage", 50, 100),
						changeId: query.get("changeId") ?? undefined,
					});
					break;
				case "/api/telemetry/spans":
					result = query.has("changeId")
						? this.db.loadSpans(query.get("changeId") ?? "")
						: this.db.recentSpans(integer("limit", 3000, 3000));
					break;
				case "/api/telemetry/metrics":
					result = this.db.loadMetrics(query.get("changeId") ?? undefined);
					break;
				case "/api/telemetry/logs":
					result = this.db.loadLogs(query.get("changeId") ?? undefined);
					break;
				case "/api/telemetry/workspaces":
					result = this.db.getWorkspaces();
					break;
				default:
					return new Response(null, { status: 404 });
			}
			return Response.json(result, {
				headers: {
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
				},
			});
		} catch {
			return Response.json(
				{ error: "Invalid telemetry query" },
				{ status: 400 },
			);
		}
	}
	async close() {
		this.closed = true;
		await this.collectors.close();
		await this.receiverWork?.catch(() => {});
		await this.stopReceiver();
		for (const stop of this.watchers.values()) stop();
		this.watchers.clear();
		while (this.scans) await Bun.sleep(1);
		await this.db.close();
	}
}
