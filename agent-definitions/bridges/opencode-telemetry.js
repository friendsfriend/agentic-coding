const fs = require("node:fs");
const path = require("node:path");
// Deterministic env backstop: herdr's agent spawn may give this process a stale
// pane env (see pi-telemetry.ts). The isolated config dir encodes the run id:
// .herdr-workflow/runtime-config/<runId>/, so recover run.env from it when the
// pane env did not arrive.
function recoverRunEnv() {
	try {
		const xdg = process.env.XDG_CONFIG_HOME;
		if (!xdg) return;
		const runId = path.basename(xdg);
		if (!/^[0-9a-f-]{36}$/.test(runId)) return;
		const file = path.join(xdg, "..", "..", "runtime-bin", runId, "run.env");
		const content = fs.readFileSync(file, "utf8");
		for (const line of content.split("\n")) {
			const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
			if (!match) continue;
			process.env[match[1]] = match[2].replace(/^'|'$/g, "");
		}
	} catch {}
}
recoverRunEnv();
const SECRET_PATTERN = /(-----BEGIN[\s\S]*?-----END[^\n]*|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|github_pat_[A-Za-z0-9_]{20,}|HERDR_RUN_TOKEN=[^\s]+)/g;
function bounded(value, max) {
	if (typeof value !== "string" || !value) return undefined;
	return value.replace(SECRET_PATTERN, "[REDACTED]").slice(0, max || 256);
}
function integer(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function errorClass(value) {
	if (value === undefined || value === null) return undefined;
	const text =
		typeof value === "string"
			? value
			: value instanceof Error
				? value.message
				: value && typeof value.message === "string"
					? value.message
					: String(value);
	const normalized = text.replace(SECRET_PATTERN, "[REDACTED]").replace(/\s+/g, " ").trim().slice(0, 160);
	return normalized || undefined;
}
function byteSize(value) {
	if (value === undefined || value === null) return undefined;
	try {
		return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
	} catch {
		return undefined;
	}
}
function emit(event, fields = {}) {
	const output = process.env.HERDR_TELEMETRY_PATH;
	const envelope = {
		schemaVersion: 1,
		at: new Date().toISOString(),
		layer: "runtime",
		runtime: "opencode",
		event,
		workflowId: process.env.HERDR_WORKFLOW_ID,
		runId: process.env.HERDR_RUN_ID,
		stepId: process.env.HERDR_STEP_ID,
		role: process.env.HERDR_ROLE,
		profile: process.env.HERDR_PROFILE,
		traceparent: process.env.TRACEPARENT,
		...fields,
	};
	if (output)
		try {
			fs.mkdirSync(path.dirname(output), { recursive: true });
			fs.appendFileSync(output, `${JSON.stringify(envelope)}\n`);
		} catch {}
	const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (endpoint)
		void fetch(`${endpoint.replace(/\/$/, "")}/v1/logs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(envelope),
			signal: AbortSignal.timeout(750),
		}).catch(() => undefined);
}
// Noise families carry no analysis value and are dropped at the bridge (D7).
function isNoise(type) {
	return (
		type === "pty" ||
		type.startsWith("pty.") ||
		type === "tui" ||
		type.startsWith("tui.") ||
		type === "server" ||
		type.startsWith("server.") ||
		type === "installation" ||
		type.startsWith("installation.") ||
		type.startsWith("lsp") ||
		type.startsWith("file.watcher")
	);
}
const permissionAskedAt = new Map();
let stepStartedAt;
function partOf(properties) {
	return (properties && properties.part) || properties || {};
}
function identity(properties) {
	const info = properties && properties.info ? properties.info : undefined;
	const part = partOf(properties);
	// v1 `message.part.updated` keeps the session id on the part; v2 duplicates it
	// on `properties` (OPENSPEC-009).
	const sessionID =
		(properties && properties.sessionID) || (part && part.sessionID);
	const model =
		(properties && properties.modelID) ||
		(part && part.modelID) ||
		(info && info.modelID);
	const provider =
		(properties && properties.providerID) ||
		(part && part.providerID) ||
		(info && info.providerID);
	return {
		...(sessionID ? { sessionId: sessionID } : {}),
		...(model ? { "oc.model": model } : {}),
		...(provider ? { "oc.provider": provider } : {}),
	};
}
function handlePart(type, properties) {
	const part = partOf(properties);
	const partType = part.type;
	if (partType === "step-start") {
		stepStartedAt = Date.now();
		return;
	}
	if (partType === "step-finish") {
		const tokens = part.tokens || {};
		const cache = tokens.cache || {};
		const duration =
			integer(part.time && part.time.duration) ||
			integer(part.durationMs) ||
			(stepStartedAt !== undefined
				? Math.max(0, Date.now() - stepStartedAt)
				: undefined);
		stepStartedAt = undefined;
		emit("runtime.step_finish", {
			...identity(properties),
			...(integer(part.cost) !== undefined ? { "oc.cost": integer(part.cost) } : {}),
			...(integer(tokens.input) !== undefined ? { "oc.tokens.input": integer(tokens.input) } : {}),
			...(integer(tokens.output) !== undefined ? { "oc.tokens.output": integer(tokens.output) } : {}),
			...(integer(tokens.reasoning) !== undefined ? { "oc.tokens.reasoning": integer(tokens.reasoning) } : {}),
			...(integer(cache.read) !== undefined ? { "oc.tokens.cache_read": integer(cache.read) } : {}),
			...(integer(cache.write) !== undefined ? { "oc.tokens.cache_write": integer(cache.write) } : {}),
			...(bounded(part.reason, 64) ? { "oc.finish.reason": bounded(part.reason, 64) } : {}),
			...(duration !== undefined ? { "oc.step.duration_ms": duration } : {}),
		});
		return;
	}
	if (partType === "tool") {
		const state = part.state || {};
		const time = state.time || {};
		const duration =
			integer(time.end) !== undefined && integer(time.start) !== undefined
				? Math.max(0, integer(time.end) - integer(time.start))
				: undefined;
		const inputBytes = byteSize(state.input);
		const outputBytes = byteSize(state.output);
		const failed = state.status === "error" || state.error !== undefined;
		const classification = failed ? errorClass(state.error) : undefined;
		emit("runtime.tool", {
			...identity(properties),
			...(bounded(part.tool, 128) ? { "oc.tool.name": bounded(part.tool, 128) } : {}),
			...(bounded(part.callID, 128) ? { "oc.tool.call_id": bounded(part.callID, 128) } : {}),
			...(bounded(state.status, 32) ? { "oc.tool.status": bounded(state.status, 32) } : {}),
			...(duration !== undefined ? { "oc.tool.duration_ms": duration } : {}),
			...(inputBytes !== undefined ? { "oc.tool.input_bytes": inputBytes } : {}),
			...(outputBytes !== undefined ? { "oc.tool.output_bytes": outputBytes } : {}),
			...(classification ? { "oc.error.class": classification } : {}),
			...(failed ? { outcome: "error" } : {}),
		});
		return;
	}
	if (partType === "text" || partType === "reasoning") {
		const length = typeof part.text === "string" ? part.text.length : integer(part.length);
		emit("runtime.part_length", {
			...identity(properties),
			"oc.part.type": partType,
			...(length !== undefined ? { "oc.part.length": length } : {}),
		});
		return;
	}
	if (partType === "retry") {
		emit("runtime.retry", {
			...identity(properties),
			...(integer(part.attempt) !== undefined ? { "oc.retry.attempt": integer(part.attempt) } : {}),
			...(bounded(part.reason, 128) ? { "oc.retry.reason": bounded(part.reason, 128) } : {}),
		});
		return;
	}
	if (partType === "compaction") {
		emit("runtime.compaction", {
			...identity(properties),
			"oc.compaction.automatic": part.auto === true || part.automatic === true,
		});
		return;
	}
	emit("runtime.part", { ...identity(properties), "oc.part.type": bounded(partType, 64) || type });
}
function handleSessionStatus(type, properties) {
	const info = properties && properties.status ? properties.status : properties && properties.info ? properties.info : properties || {};
	const status = typeof info.type === "string" ? info.type : typeof info.status === "string" ? info.status : undefined;
	if (!status) return;
	const retry = info.retry || info;
	emit("runtime.session_status", {
		...identity(properties),
		"oc.session.status": bounded(status, 32),
		...(status === "retry" && integer(retry.attempt) !== undefined ? { "oc.retry.attempt": integer(retry.attempt) } : {}),
		...(status === "retry" && integer(retry.next) !== undefined ? { "oc.retry.delay_ms": integer(retry.next) } : {}),
		...(status === "retry" && bounded(retry.message, 128) ? { "oc.retry.reason": bounded(retry.message, 128) } : {}),
	});
}
function handleSessionError(properties) {
	const error = (properties && properties.error) || properties || {};
	const retryable =
		typeof (properties && properties.retryable) === "boolean"
			? properties.retryable
			: typeof error.retryable === "boolean"
				? error.retryable
				: undefined;
	emit("runtime.session_error", {
		...identity(properties),
		outcome: "error",
		...(errorClass(error && (error.message || error.name) ? `${error.name || ""} ${error.message || ""}`.trim() : error)
			? { "oc.error.class": errorClass(error && (error.message || error.name) ? `${error.name || ""} ${error.message || ""}`.trim() : error) }
			: {}),
		...(retryable !== undefined ? { "oc.error.retryable": retryable } : {}),
	});
}
function handlePermission(type, properties) {
	const record = properties || {};
	if (type === "permission.asked" || type === "permission.requested") {
		const id = bounded(record.id || record.requestID || record.permissionID, 128);
		if (id) permissionAskedAt.set(id, Date.now());
		emit("runtime.permission_request", {
			...identity(record),
			...(id ? { "oc.permission.id": id } : {}),
			...(bounded(record.permission || record.type, 64) ? { "oc.permission.type": bounded(record.permission || record.type, 64) } : {}),
			...(Array.isArray(record.patterns) ? { "oc.permission.patterns": record.patterns.length } : {}),
		});
		return;
	}
	const id = bounded(record.id || record.requestID || record.permissionID, 128);
	const startedAt = id ? permissionAskedAt.get(id) : undefined;
	if (id) permissionAskedAt.delete(id);
	emit("runtime.permission_reply", {
		...identity(record),
		...(id ? { "oc.permission.id": id } : {}),
		...(bounded(record.reply || record.response || record.result, 64) ? { "oc.permission.reply": bounded(record.reply || record.response || record.result, 64) } : {}),
		...(startedAt !== undefined ? { "oc.permission.duration_ms": Math.max(0, Date.now() - startedAt) } : {}),
	});
}
function handleTodos(properties) {
	const todos = (properties && properties.todos) || [];
	const counts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
	if (Array.isArray(todos))
		for (const todo of todos)
			if (todo && typeof todo.status === "string" && counts[todo.status] !== undefined) counts[todo.status] += 1;
	emit("runtime.todos", {
		...identity(properties),
		"oc.todo.total": Array.isArray(todos) ? todos.length : 0,
		"oc.todo.pending": counts.pending,
		"oc.todo.in_progress": counts.in_progress,
		"oc.todo.completed": counts.completed,
		"oc.todo.cancelled": counts.cancelled,
	});
}
function handleDiff(properties) {
	const raw = (properties && (properties.diff || properties.diffs)) || [];
	const files = Array.isArray(raw) ? raw : [];
	let additions = 0;
	let deletions = 0;
	for (const entry of files) {
		if (!entry || typeof entry !== "object") continue;
		additions += integer(entry.additions) || 0;
		deletions += integer(entry.deletions) || 0;
	}
	emit("runtime.diff", {
		...identity(properties),
		"oc.diff.files": files.length,
		"oc.diff.additions": additions,
		"oc.diff.deletions": deletions,
	});
}
// Telemetry only: runtime lifecycle events. Handoff and checks go through the
// agent's normal tools (`agentic-coding workflow handoff`).
module.exports = async () => ({
	event: async ({ event }) => {
		const type = event && typeof event.type === "string" ? event.type : undefined;
		if (!type || isNoise(type)) return;
		const properties = event.properties || {};
		if (type === "message.part.updated") return handlePart(type, properties);
		if (type === "session.status" || type === "session.updated") return handleSessionStatus(type, properties);
		if (type === "session.error") return handleSessionError(properties);
		if (type === "permission.asked" || type === "permission.requested" || type === "permission.replied") return handlePermission(type, properties);
		if (type === "todo.updated") return handleTodos(properties);
		if (type === "session.diff") return handleDiff(properties);
		if (type === "message.updated") return emit("runtime.message", identity(properties));
		emit(`runtime.${type}`, identity(properties));
	},
});
