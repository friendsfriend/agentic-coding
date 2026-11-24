import { randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import { TelemetryCertificate } from "./certificate.ts";

type Span = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTime: number;
	endTime: number;
	status: string;
	attributes: Record<string, string>;
};
type TreeNode = {
	spanId: string;
	parentSpanId?: string;
	name: string;
	status: string;
	startTime: number;
	endTime: number;
	durationMs: number;
	attributes: Record<string, string>;
	children: TreeNode[];
};
const tree = (values: Span[]): TreeNode[] => {
	const nodes = new Map<string, TreeNode>(
		values.map((span) => [
			span.spanId,
			{
				spanId: span.spanId,
				...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
				name: span.name,
				status: span.status,
				startTime: span.startTime,
				endTime: span.endTime,
				durationMs: Math.max(0, span.endTime - span.startTime),
				attributes: span.attributes,
				children: [],
			},
		]),
	);
	const roots: TreeNode[] = [];
	for (const node of nodes.values()) {
		const parent = node.parentSpanId ? nodes.get(node.parentSpanId) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	const sort = (entries: TreeNode[]) => {
		entries.sort(
			(left, right) =>
				left.startTime - right.startTime ||
				left.spanId.localeCompare(right.spanId),
		);
		for (const entry of entries) sort(entry.children);
	};
	sort(roots);
	return roots;
};
type Log = {
	time: number;
	severity: string;
	body: string;
	traceId?: string;
	spanId?: string;
	attributes: Record<string, string>;
};
const text = (value: unknown) =>
	typeof value === "string" ? value : undefined;
const attributes = (raw: unknown) => {
	if (!Array.isArray(raw)) return {};
	const result: Record<string, string> = {};
	for (const item of raw.slice(0, 64)) {
		if (!item || typeof item !== "object") continue;
		const entry = item as { key?: unknown; value?: unknown };
		const key = text(entry.key);
		const value = entry.value as Record<string, unknown> | undefined;
		if (!key || !value) continue;
		const selected =
			text(value.stringValue) ??
			text(value.boolValue) ??
			text(value.intValue) ??
			text(value.doubleValue);
		if (selected !== undefined)
			result[key.slice(0, 256)] = selected.slice(0, 1024);
	}
	return result;
};
const nano = (value: unknown, fallback = 0) => {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: Number.NaN;
	return Number.isFinite(parsed) ? Math.floor(parsed / 1_000_000) : fallback;
};
const traceId = (value: unknown) =>
	typeof value === "string" && /^[a-f0-9]{32}$/.test(value) ? value : undefined;
const spanId = (value: unknown) =>
	typeof value === "string" && /^[a-f0-9]{16}$/.test(value) ? value : undefined;

/** Bounded OTLP/HTTP JSON receiver for one owned run. Shell processes use a
 * loopback listener. Compose telemetry uses a fresh TLS host-gateway listener;
 * the collector receives a CA mount and the receiver never writes received
 * telemetry or the bearer token to disk. */
export function createTelemetryReceiver(options: {
	app: string;
	scope: string;
	redact: (value: string) => string;
	transport?: "loopback" | "tls-host-gateway-v1";
	stateDir?: string;
}) {
	const token = randomBytes(32).toString("hex");
	const authorization = `Bearer ${token}`;
	const spans = new Map<string, Span[]>();
	const logs: Log[] = [];
	let bytes = 0;
	let closed = false;
	const transport = options.transport ?? "loopback";
	const certificate =
		transport === "tls-host-gateway-v1"
			? new TelemetryCertificate(options.stateDir ?? os.tmpdir())
			: undefined;
	const clean = (value: string) => options.redact(value).slice(0, 4096);
	const server = Bun.serve({
		hostname: transport === "loopback" ? "127.0.0.1" : "0.0.0.0",
		port: 0,
		development: false,
		maxRequestBodySize: 64 * 1024,
		idleTimeout: 5,
		...(certificate
			? { tls: { cert: certificate.certificate, key: certificate.key } }
			: {}),
		async fetch(request) {
			if (closed) return new Response(null, { status: 503 });
			const url = new URL(request.url);
			const host = request.headers.get("host");
			if (transport === "loopback") {
				if (
					url.origin !== `http://127.0.0.1:${server.port}` ||
					host !== `127.0.0.1:${server.port}` ||
					url.username ||
					url.password
				)
					return new Response(null, { status: 403 });
			} else if (
				![
					`host.docker.internal:${server.port}`,
					`127.0.0.1:${server.port}`,
					`[::1]:${server.port}`,
				].includes(host ?? "")
			)
				return new Response(null, { status: 403 });
			const supplied = request.headers.get("authorization") ?? "";
			if (
				supplied.length !== authorization.length ||
				!timingSafeEqual(Buffer.from(supplied), Buffer.from(authorization))
			)
				return new Response(null, { status: 401 });
			if (
				request.method !== "POST" ||
				!["/v1/traces", "/v1/logs"].includes(url.pathname)
			)
				return new Response(null, { status: 404 });
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 5000);
			try {
				const body = await request.text();
				bytes += Buffer.byteLength(body);
				if (bytes > 2 * 1024 * 1024) return new Response(null, { status: 413 });
				const parsed = JSON.parse(body) as Record<string, unknown>;
				if (url.pathname === "/v1/traces") ingestTraces(parsed);
				else ingestLogs(parsed);
				return new Response(null, { status: 200 });
			} catch {
				return new Response(null, { status: 400 });
			} finally {
				clearTimeout(timer);
			}
		},
	});
	const ingestTraces = (payload: Record<string, unknown>) => {
		const resourceSpans = Array.isArray(payload.resourceSpans)
			? payload.resourceSpans
			: [];
		for (const resource of resourceSpans.slice(0, 64)) {
			if (!resource || typeof resource !== "object") continue;
			const scopes = (resource as { scopeSpans?: unknown }).scopeSpans;
			if (!Array.isArray(scopes)) continue;
			for (const scope of scopes.slice(0, 64)) {
				if (!scope || typeof scope !== "object") continue;
				const rawSpans = (scope as { spans?: unknown }).spans;
				if (!Array.isArray(rawSpans)) continue;
				for (const raw of rawSpans.slice(0, 500)) {
					if (!raw || typeof raw !== "object") continue;
					const span = raw as Record<string, unknown>;
					const id = spanId(span.spanId),
						trace = traceId(span.traceId),
						name = text(span.name);
					if (!id || !trace || !name) continue;
					const stored: Span = {
						traceId: trace,
						spanId: id,
						...(spanId(span.parentSpanId)
							? { parentSpanId: spanId(span.parentSpanId) }
							: {}),
						name: clean(name),
						startTime: nano(span.startTimeUnixNano),
						endTime: nano(span.endTimeUnixNano),
						status: clean(
							text((span.status as { code?: unknown } | undefined)?.code) ??
								"unset",
						),
						attributes: Object.fromEntries(
							Object.entries(attributes(span.attributes)).map(
								([key, value]) => [clean(key), clean(value)],
							),
						),
					};
					const selected = spans.get(trace) ?? [];
					if (
						!selected.some((entry) => entry.spanId === stored.spanId) &&
						selected.length < 500
					)
						spans.set(trace, [...selected, stored]);
				}
			}
		}
		while (spans.size > 200) {
			const oldest = spans.keys().next().value;
			if (!oldest) break;
			spans.delete(oldest);
		}
	};
	const ingestLogs = (payload: Record<string, unknown>) => {
		const resourceLogs = Array.isArray(payload.resourceLogs)
			? payload.resourceLogs
			: [];
		for (const resource of resourceLogs.slice(0, 64)) {
			if (!resource || typeof resource !== "object") continue;
			const scopes = (resource as { scopeLogs?: unknown }).scopeLogs;
			if (!Array.isArray(scopes)) continue;
			for (const scope of scopes.slice(0, 64)) {
				if (!scope || typeof scope !== "object") continue;
				const records = (scope as { logRecords?: unknown }).logRecords;
				if (!Array.isArray(records)) continue;
				for (const raw of records.slice(0, 1000)) {
					if (!raw || typeof raw !== "object") continue;
					const record = raw as Record<string, unknown>;
					const bodyValue = record.body as Record<string, unknown> | undefined;
					const body =
						text(bodyValue?.stringValue) ??
						text(bodyValue?.intValue) ??
						text(bodyValue?.doubleValue) ??
						"";
					logs.push({
						time: nano(record.timeUnixNano ?? record.observedTimeUnixNano),
						severity: clean(text(record.severityText) ?? "INFO"),
						body: clean(body),
						...(traceId(record.traceId)
							? { traceId: traceId(record.traceId) }
							: {}),
						...(spanId(record.spanId) ? { spanId: spanId(record.spanId) } : {}),
						attributes: Object.fromEntries(
							Object.entries(attributes(record.attributes)).map(
								([key, value]) => [clean(key), clean(value)],
							),
						),
					});
				}
			}
		}
		logs.splice(0, Math.max(0, logs.length - 1000));
	};
	const collectorEnvironment = () => {
		if (!certificate)
			throw new Error("TLS telemetry certificate is unavailable");
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
						endpoint: `https://host.docker.internal:${server.port}`,
						encoding: "json",
						compression: "none",
						headers: { Authorization: authorization },
						tls: { ca_file: "/environment-mcp-otel-ca.pem" },
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
	};
	const processEnv: Record<string, string> =
		transport === "loopback"
			? {
					OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.port}`,
					OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
					OTEL_EXPORTER_OTLP_HEADERS: `authorization=${encodeURIComponent(authorization)}`,
					OTEL_RESOURCE_ATTRIBUTES: `environment.app=${options.app},environment.scope=${options.scope}`,
					OTEL_METRICS_EXPORTER: "none",
				}
			: {};
	return {
		env: processEnv,
		transport,
		collectorEnvironment,
		containerEnvironment() {
			if (!certificate)
				throw new Error("TLS telemetry certificate is unavailable");
			return {
				OTEL_EXPORTER_OTLP_ENDPOINT: `https://host.docker.internal:${server.port}`,
				OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
				OTEL_EXPORTER_OTLP_HEADERS: `authorization=${encodeURIComponent(authorization)}`,
				OTEL_EXPORTER_OTLP_CERTIFICATE: "/environment-mcp-otel-ca.pem",
				OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
				OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
				OTEL_RESOURCE_ATTRIBUTES: `environment.app=${options.app},environment.scope=${options.scope}`,
				OTEL_METRICS_EXPORTER: "none",
				OTEL_TRACES_EXPORTER: "otlp",
				OTEL_LOGS_EXPORTER: "otlp",
			};
		},
		collectorCertificatePath() {
			if (!certificate)
				throw new Error("TLS telemetry certificate is unavailable");
			return certificate.path;
		},
		snapshot() {
			return {
				app: options.app,
				transport,
				bytes,
				logs: logs.slice(-200),
				traces: [...spans.entries()].slice(-100).map(([id, values]) => ({
					traceId: id,
					spanCount: values.length,
					startTime: Math.min(...values.map((span) => span.startTime)),
					endTime: Math.max(...values.map((span) => span.endTime)),
					root:
						values.find((span) => !span.parentSpanId)?.name ?? values[0]?.name,
					errors: values.filter((span) => span.status === "2").length,
				})),
			};
		},
		trace(id: string) {
			const values = spans.get(id);
			if (!values) return null;
			return {
				traceId: id,
				spans: values,
				tree: tree(values),
			};
		},
		close() {
			if (closed) return;
			closed = true;
			server.stop(true);
			try {
				certificate?.close();
			} catch {
				// Certificate files are retained for inspection; no cleanup claim is made.
			}
		},
	};
}
