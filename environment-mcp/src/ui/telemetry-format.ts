type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: {};
const entries = (value: unknown): unknown[] =>
	Array.isArray(value) ? value : [];
const text = (value: unknown) =>
	typeof value === "string" ? value : undefined;
const count = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;
const clean = (value: unknown, limit = 160) => {
	const selected = text(value);
	if (!selected) return "";
	return selected
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, limit);
};
const milliseconds = (value: unknown) => {
	const parsed = count(value);
	return parsed !== undefined ? Math.max(0, Math.round(parsed)) : 0;
};
const timestamp = (value: unknown) => {
	const millis = count(value);
	if (millis === undefined) return "?";
	const date = new Date(millis);
	return Number.isNaN(date.getTime()) ? "?" : date.toISOString().slice(11, 23);
};
const status = (value: unknown) =>
	value === "2" || value === 2
		? "error"
		: value === "1" || value === 1
			? "ok"
			: "unset";
const attributes = (value: unknown) => {
	const selected = Object.entries(object(value))
		.slice(0, 3)
		.map(([key, entry]) => `${clean(key, 64)}=${clean(entry, 80)}`)
		.filter((entry) => !entry.endsWith("="));
	return selected.length ? ` · ${selected.join(" ")}` : "";
};
const duration = (value: unknown) => {
	const millis = milliseconds(value);
	return millis >= 1000 ? `${(millis / 1000).toFixed(1)}s` : `${millis}ms`;
};

/** Terminal trace-tree formatter for the `env_telemetry` result. It consumes the
 * same bounded data the agent tool returns; unknown shapes fall back to JSON at
 * the controller boundary. */
export function formatTelemetryResult(value: JsonObject) {
	const lines: string[] = [];
	const app = clean(value.app, 64) || "app";
	const trace = object(value.trace);
	if (Object.keys(trace).length) {
		const spans = entries(trace.spans);
		lines.push(
			`Telemetry trace ${clean(trace.traceId, 64) || "unknown"} · ${spans.length} span${spans.length === 1 ? "" : "s"} · ${app}`,
		);
		const tree = entries(trace.tree);
		if (!tree.length) throw new Error("trace-tree-unavailable");
		let nodes = 0;
		const render = (values: unknown[], depth: number) => {
			for (const raw of values) {
				if (nodes >= 500 || depth > 20) return;
				const node = object(raw);
				const name = clean(node.name) || "(unnamed)";
				const selectedStatus = status(node.status);
				const selectedDuration =
					typeof node.durationMs === "number"
						? duration(node.durationMs)
						: duration(
								(count(node.endTime) ?? 0) - (count(node.startTime) ?? 0),
							);
				const prefix = depth === 0 ? "▸ " : `${"  ".repeat(depth)}└─ `;
				lines.push(
					`${prefix}${name} · ${selectedDuration} · ${selectedStatus}${attributes(node.attributes)}`,
				);
				nodes++;
				render(entries(node.children), depth + 1);
			}
		};
		render(tree, 0);
		return lines.join("\n");
	}
	const logs = entries(value.logs);
	const traces = entries(value.traces);
	lines.push(
		`Telemetry · ${app} · ${clean(value.transport, 64) || "unknown"} · ${count(value.bytes) ?? 0} bytes`,
	);
	if (logs.length) {
		lines.push("", `Logs (${logs.length})`);
		for (const raw of logs.slice(-100)) {
			const log = object(raw);
			const traceId = clean(log.traceId, 32);
			lines.push(
				`${timestamp(log.time)} ${clean(log.severity, 16) || "INFO"} ${clean(log.body, 240) || "(empty)"}${traceId ? ` · trace ${traceId.slice(0, 12)}` : ""}`,
			);
		}
	}
	if (traces.length) {
		lines.push("", `Traces (${traces.length})`);
		for (const raw of traces.slice(-100)) {
			const summary = object(raw);
			const errors = count(summary.errors) ?? 0;
			lines.push(
				`${clean(summary.traceId, 64) || "unknown"} · ${clean(summary.root) || "(unnamed)"} · ${count(summary.spanCount) ?? 0} spans · ${errors} error${errors === 1 ? "" : "s"}`,
			);
		}
		lines.push("", "Run env_telemetry with a traceId to view its tree.");
	}
	if (!logs.length && !traces.length)
		lines.push("", "No captured spans or logs.");
	return lines.join("\n");
}
