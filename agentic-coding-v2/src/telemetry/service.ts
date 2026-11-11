// v1 receiver/storage composition, owned by the v2 runtime. Receiver input is
// data, never native task/lease authority. Reads share the authenticated host.
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { routeReceiverRequest, type SignalRouter } from "./receivers/index.ts";
import { TraceDb } from "./telemetry-db.ts";

export class Telemetry {
	readonly db: TraceDb;
	revision = 0;
	private readonly router: SignalRouter;
	private readonly watchers = new Map<string, () => void>();
	private closed = false;
	private scans = 0;
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
	constructor(directory: string) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		this.db = new TraceDb(directory);
		chmodSync(directory, 0o700);
		chmodSync(join(directory, "traces.sqlite"), 0o600);
		this.router = {
			pushTraces: (spans) => {
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
				for (const metric of metrics)
					this.db.ingestMetrics(metric.serviceName || "unknown", [metric]);
				if (metrics.length) this.revision++;
			},
			pushLogs: (logs) => {
				for (const log of logs)
					this.db.ingestLogs(log.serviceName || "unknown", [log]);
				if (logs.length) this.revision++;
			},
		};
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
		for (const stop of this.watchers.values()) stop();
		this.watchers.clear();
		while (this.scans) await Bun.sleep(1);
		await this.db.close();
	}
}
