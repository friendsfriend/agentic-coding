// Wire-only types. No Runtime, storage, renderer or model-provider dependencies.
export const protocolVersion = 1;
export const clientPath = "/api/client";
export const maxFrameBytes = 1_000_000;
export type Data = Record<string, unknown>;
export type Session = {
	id: number;
	parent: number | null;
	task: number | null;
	title: string;
	writable: boolean;
};
export type Snapshot = {
	tasks: Data[];
	reviews: Data[];
	schedules: Data[];
	profiles: Data[];
	topics: Data[];
	repositories: string[];
	environments: Data;
	sessions: Session[];
};
export type ToolProgress = {
	callId: string;
	name: string;
	status: "pending" | "running" | "done";
	taskId?: number;
	entry?: number;
	output?: string;
	droppedBytes?: number;
	droppedLines?: number;
	details?: unknown;
	diagnostics?: Data[];
	parentCallId?: string;
	parentTaskId?: number;
	arguments?: Data;
	summary?: Data;
};
export type Progress = {
	run: { taskId: number; inputs: number[] } | null;
	generation: {
		attempt: number;
		message?: Data;
		retry?: { at: number; error: string };
		deferred?: { pollAt: number };
	} | null;
	tools: ToolProgress[];
	nestedTools: ToolProgress[];
	compactions: Data[];
	compactionFailure: Data | null;
	inbox: { id: number; mode: "steer" | "followUp" | "write" }[];
};
export type Transcript = {
	id: number;
	model: string | null;
	thinking: string;
	entries: Data[];
	truncated: boolean;
	progress: Progress;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	};
};
export type EnvironmentAction = {
	apps: string[];
	action: "run" | "build" | "test";
	requestId: string;
	baseRef?: string;
	workspaceMode?: "checkout" | "worktree";
	target?: string;
	profile?: string;
	runtime?:
		| "shell"
		| "systemshell"
		| "powershell"
		| "docker"
		| "podman"
		| "compose"
		| "kubernetes";
	replicas?: number;
};
export type Methods = {
	"state.read": { input: Data; output: Snapshot };
	"state.subscribe": { input: Data; output: { subscribed: true } };
	"session.read": { input: { id: number }; output: Transcript };
	"session.watch": {
		input: { id: number | null; watchId: string };
		output: { id: number | null; watchId: string };
	};
	"session.send": {
		input: { id: number; content: string; requestId: string };
		output: { submissionId: number };
	};
	"session.abort": { input: { id: number }; output: { aborted: true } };
	"session.compact": {
		input: { id: number; instructions?: string };
		output: { taskId: number };
	};
	"session.configure": {
		input: { id: number; profile: string };
		output: { configured: true };
	};
	"task.cancel": { input: { id: number }; output: { requested: unknown } };
	"review.decide": {
		input: {
			id: string;
			revision: number;
			decision: "approved" | "rejected" | "changes-requested";
			comments: string;
		};
		output: { decided: true };
	};
	"schedule.delete": {
		input: { id: string; revision: number };
		output: { deleted: true };
	};
	"environment.action": {
		input: EnvironmentAction;
		output: { taskId: number };
	};
	"environment.logs": { input: { app: string }; output: unknown };
	"providers.read": { input: Data; output: unknown };
};
export type Method = keyof Methods;
export type Request = { version: 1; id: string; method: Method; input: Data };
export type Frame =
	| { version: 1; type: "hello"; connection: string; methods: Method[] }
	| { version: 1; type: "response"; id: string; value: unknown }
	| {
			version: 1;
			type: "error";
			id: string | null;
			code: "invalid-request" | "refused" | "unavailable";
			message: string;
	  }
	| { version: 1; type: "state"; sequence: number; value: Snapshot }
	| {
			version: 1;
			type: "session";
			sequence: number;
			watchId: string;
			value: Transcript;
	  }
	| {
			version: 1;
			type: "session-unavailable";
			sequence: number;
			watchId: string;
			message: string;
	  };
export const methods: Method[] = [
	"state.read",
	"state.subscribe",
	"session.read",
	"session.watch",
	"session.send",
	"session.abort",
	"session.compact",
	"session.configure",
	"task.cancel",
	"review.decide",
	"schedule.delete",
	"environment.action",
	"environment.logs",
	"providers.read",
];
export function record(value: unknown): Data {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected an object");
	return value as Data;
}
export function request(value: unknown): Request {
	const body = record(value);
	if (
		Object.keys(body).some(
			(key) => !["version", "id", "method", "input"].includes(key),
		) ||
		body.version !== protocolVersion ||
		typeof body.id !== "string" ||
		!/^[a-zA-Z0-9:_-]{1,128}$/.test(body.id) ||
		!methods.includes(body.method as Method)
	)
		throw new Error("Unsupported client request");
	return {
		version: 1,
		id: body.id,
		method: body.method as Method,
		input: record(body.input),
	};
}
