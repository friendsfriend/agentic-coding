// v1 receiver/storage composition, owned by the v2 runtime. Receiver input is
// data, never native task/lease authority. Reads share the authenticated host.
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { routeReceiverRequest, type SignalRouter } from "./receivers/index.ts";
import { TraceDb } from "./telemetry-db.ts";

export class Telemetry {
	readonly db: TraceDb;
	private readonly router: SignalRouter;
	constructor(directory: string) {
		this.db = new TraceDb(directory);
		chmodSync(directory, 0o700);
		chmodSync(join(directory, "traces.sqlite"), 0o600);
		this.router = {
			pushTraces: (spans) => {
				for (const span of spans) this.db.ingestSpan(span.traceId, span);
			},
			pushMetrics: (metrics) => {
				for (const metric of metrics)
					this.db.ingestMetrics(metric.serviceName || "unknown", [metric]);
			},
			pushLogs: (logs) => {
				for (const log of logs)
					this.db.ingestLogs(log.serviceName || "unknown", [log]);
			},
		};
	}
	async route(request: Request, url: URL): Promise<Response | null> {
		const received = routeReceiverRequest(request, this.router);
		if (received) return received;
		if (!url.pathname.startsWith("/api/telemetry/")) return null;
		if (request.method !== "GET") return new Response(null, { status: 405 });
		const query = url.searchParams;
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
			return Response.json(result);
		} catch {
			return Response.json(
				{ error: "Invalid telemetry query" },
				{ status: 400 },
			);
		}
	}
	close() {
		this.db.close();
	}
}
