import type {
	MetricCollectorKind,
	MetricCollectorSnapshot,
	TelemetryReceiverState,
	TraceFilterCatalog,
} from "../telemetry/contracts.ts";
// Wire-only types. No Runtime, storage, renderer or model-provider dependencies.
export const protocolVersion = 1;
export const clientPath = "/api/client";
export const maxFrameBytes = 1_000_000;

import type {
	EnvironmentCandidate,
	EnvironmentInspection,
	EnvironmentIntention,
} from "./environment-workbench.ts";
import type { EvidenceDocument } from "./evidence.ts";
import type {
	ProviderActionCandidate,
	ProviderActionIntent,
	ProviderActionReceipt,
} from "./provider-actions.ts";
import type { StandaloneMethods } from "./standalone.ts";
import type { NativeViewpoint, UiView } from "./viewpoints.ts";
export type Data = Record<string, unknown>;
export type Session = {
	id: number;
	parent: number | null;
	task: number | null;
	title: string;
	writable: boolean;
};
export type Snapshot = {
	telemetryRevision?: number;
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
/** Explicit read-only native context projection; no approval revision or token estimate. */
export type SessionContext = {
	id: number;
	head: Data | null;
	entries: Data[];
	contributions: Data[][];
	messages: Data[];
	model: {
		provider: string;
		modelId: string;
		catalogued: boolean;
		contextWindow: number | null;
		maxOutput: number | null;
	} | null;
	thinking: string;
};
export type SessionHistoryPage = {
	id: number;
	entries: Data[];
	cursor: string | null;
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
export type SkillSummary = {
	id: string;
	origin: "system" | "user";
	description: string;
	revision: string;
	readOnly: boolean;
};
export type SkillDocument = SkillSummary & { content: string };
export type SkillFileDocument = {
	name: string;
	revision: string;
	directoryIdentity: string;
	content: string;
	restartRequired: true;
};
export type SkillFileCandidate = Omit<SkillFileDocument, "revision"> & {
	id: string;
	baseRevision: string;
	digest: string;
	snapshot: string;
	expiresAt: number;
};
export type SettingsDefinition = {
	profiles: Record<
		string,
		{ model: string; thinking: string; description: string }
	>;
	orchestratorProfile: string;
	repositories: string[];
	providers: {
		name: string;
		type: "github" | "gitlab";
		baseUrl: string;
		username?: string;
		tokenRef?: string;
	}[];
};
export type SettingsDocument = {
	revision: string;
	settings: SettingsDefinition;
	restartRequired: true;
};
export type SettingsCandidate = {
	id: string;
	baseRevision: string;
	digest: string;
	snapshot: string;
	expiresAt: number;
	restartRequired: true;
};
export type ProviderSummary = {
	name: string;
	type: "github" | "gitlab";
	baseUrl: string;
	username: string;
	has_token: boolean;
};
export type ProviderQuery = { provider: string } & (
	| { operation: "repos"; query: string }
	| { operation: "branches" | "labels" | "collaborators"; repo: string }
	| {
			operation: "changes" | "issues";
			repo: string;
			state?: "open" | "closed" | "all";
	  }
	| {
			operation: "change" | "issue" | "files" | "versions" | "discussions";
			repo: string;
			number: number;
	  }
	| { operation: "jobs"; repo: string; run?: number }
);
export type ProviderInspection = {
	provider: string;
	operation: ProviderQuery["operation"];
	value: Data | Data[];
};
export type OwnedWork = {
	items: {
		id: number;
		parent: number | null;
		conversationId: number;
		state: string;
		until: number | null;
		reason: string | null;
		reasonTruncated: boolean;
	}[];
	truncated: boolean;
};
export type TaskDetails = {
	ownedWork: OwnedWork;
	id: number;
	metadata: Data;
	native: {
		status: string;
		abortRequested: boolean;
		outcome: Data | null;
	} | null;
	reviews: Data[];
	attachments: {
		id: string;
		taskId: number;
		mediaType: string;
		caption: string;
	}[];
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
	"telemetry.filters.read": {
		input: Record<string, never>;
		output: TraceFilterCatalog;
	};
	"telemetry.trace.resolve": {
		input: { traceId: string; spanId?: string };
		output: { changeId: string; traceId: string; spanId: string | null } | null;
	};
	"telemetry.collector.read": {
		input: Record<string, never>;
		output: MetricCollectorSnapshot;
	};
	"telemetry.collector.start": {
		input: { kind: MetricCollectorKind; revision: number; port: number };
		output: MetricCollectorSnapshot;
	};
	"telemetry.collector.stop": {
		input: { kind: MetricCollectorKind; revision: number };
		output: MetricCollectorSnapshot;
	};
	"telemetry.receiver.read": {
		input: Record<string, never>;
		output: TelemetryReceiverState;
	};
	"telemetry.receiver.start": {
		input: { revision: number; port: number };
		output: TelemetryReceiverState;
	};
	"telemetry.receiver.stop": {
		input: { revision: number };
		output: TelemetryReceiverState;
	};
	"telemetry.manage": {
		input:
			| { operation: "prune"; days: number }
			| { operation: "scan" | "watch" | "unwatch"; repository: string };
		output: { count: number };
	};
	"telemetry.read": {
		input: {
			signal:
				| "traces"
				| "spans"
				| "metrics"
				| "logs"
				| "workspaces"
				| "topology";
			page?: number;
			perPage?: number;
			changeId?: string;
			limit?: number;
		};
		output: { value: unknown };
	};
	"environment.inspect": { input: EnvironmentInspection; output: unknown };
	"environment.preview": {
		input: EnvironmentIntention;
		output: EnvironmentCandidate;
	};
	"environment.apply": {
		input: { id: string; approval: string };
		output: unknown;
	};
	"viewpoints.read": { input: Data; output: NativeViewpoint[] };
	"viewpoints.save": {
		input: { id: string; name: string; revision: number; view: UiView };
		output: NativeViewpoint;
	};
	"viewpoints.remove": {
		input: { id: string; revision: number };
		output: { removed: true };
	};
	"state.read": { input: Data; output: Snapshot };
	"state.subscribe": { input: Data; output: { subscribed: true } };
	"session.context": { input: { id: number }; output: SessionContext };
	"session.read": { input: { id: number }; output: Transcript };
	"session.history": {
		input: { id: number; cursor?: string };
		output: SessionHistoryPage;
	};
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
	"evidence.read": {
		input: { taskId: number; id: string; offset?: number };
		output: EvidenceDocument;
	};
	"task.read": { input: { id: number }; output: TaskDetails };
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
	"schedule.create": {
		input: {
			id: string;
			invocation: {
				topicId: string;
				skill: string;
				profile: string;
				repository: string;
				baseRef?: string;
				inputs: string;
				requestId: string;
			};
			timing:
				| { kind: "once"; at: number }
				| { kind: "interval"; everyMs: number; anchor: number }
				| {
						kind: "calendar";
						timezone: string;
						weekdays: number[];
						hour: number;
						minute: number;
				  };
			lateGraceMs: number | null;
		};
		output: Data;
	};
	"schedule.state": {
		input: { id: string; revision: number; state: "enabled" | "paused" };
		output: { updated: true };
	};
	"environment.action": {
		input: EnvironmentAction;
		output: { taskId: number };
	};
	"environment.stop": {
		input: { runId: string; revision: number; requestId: string };
		output: { stopped: true; owner: number };
	};
	"environment.git": {
		input: {
			operation:
				| "status"
				| "branches"
				| "worktrees"
				| "fetch"
				| "pull"
				| "push"
				| "checkout"
				| "create-branch"
				| "create-worktree"
				| "remove-worktree"
				| "switch-worktree";
			app?: string;
			branch?: string;
		};
		output: Data | Data[];
	};
	"environment.cluster": {
		input: {
			operation:
				| "status"
				| "operations"
				| "create"
				| "delete"
				| "recreate"
				| "export-kubeconfig";
			cluster?: string;
			requestId?: string;
		};
		output: Data;
	};
	/** Restored v1 add/remove repository (direct developer actions). */
	"environment.apps": {
		input: {
			operation: "create" | "delete" | "pending" | "shell-target";
			displayName?: string;
			repositoryURL?: string;
			branch?: string;
			provider?: string;
			definitionLocation?: "apps" | "libraries";
			ident?: string;
			action?: "run" | "build" | "test";
			profile?: string;
			runtime?: string;
		};
		output: Data;
	};
	/** Restored v1 log AI panel (direct developer action, polled). */
	"environment.logs.analyze": {
		input: {
			operation: "start" | "read" | "cancel";
			logs?: string;
			prompt?: string;
			id?: string;
			offset?: number;
		};
		output: Data;
	};
	"environment.tasks": {
		input: {
			operation:
				| "list"
				| "metadata"
				| "create"
				| "link"
				| "delete"
				| "history"
				| "add-history";
			path?: string;
			sourcePath?: string;
			values?: Data;
			limit?: number;
		};
		output: Data | Data[];
	};
	"environment.stats": {
		input: { app: string };
		output: {
			cpuPercent: number;
			memoryUsage: number;
			memoryLimit: number;
			memoryPercent: number;
			timestamp: string;
		};
	};
	"environment.logs": { input: { app: string }; output: string };
	"wiki.list": { input: Data; output: Data[] };
	"wiki.read": {
		input: { id: string };
		output: { page: Data; comments: Data[] };
	};
	"wiki.preview": {
		input: { id: string; title: string; content: string; baseRevision: number };
		output: { id: string; snapshot: string; digest: string; expiresAt: number };
	};
	"wiki.apply": { input: { id: string; approval: string }; output: Data };
	"wiki.save": {
		input: {
			id: string;
			title: string;
			content: string;
			baseRevision: number;
		};
		output: Data;
	};
	"wiki.comment": {
		input: {
			pageId: string;
			pageRevision: number;
			comment: string;
			profile: string;
			repository: string;
			baseRef: string;
			requestId: string;
		};
		output: { taskId: number };
	};
	"skill-file.read": { input: { name: string }; output: SkillFileDocument };
	"skill-file.preview": {
		input: { name: string; baseRevision: string; content: string };
		output: SkillFileCandidate;
	};
	"skill-file.apply": {
		input: { id: string; approval: string };
		output: { name: string; revision: string; restartRequired: true };
	};
	"skills.read": { input: Data; output: SkillSummary[] };
	"skill.read": {
		input: { id: string; revision: string };
		output: SkillDocument;
	};
	"settings.read": { input: Data; output: SettingsDocument };
	"settings.models": { input: Data; output: string[] };
	"settings.profile": {
		input: {
			baseRevision: string;
			operation: "save" | "delete";
			name: string;
			originalName?: string;
			profile?: SettingsDefinition["profiles"][string];
		};
		output: SettingsDocument;
	};
	"settings.save": {
		input: { baseRevision: string; settings: SettingsDefinition };
		output: { revision: string; restartRequired: true };
	};
	"settings.preview": {
		input: { baseRevision: string; settings: SettingsDefinition };
		output: SettingsCandidate;
	};
	"settings.apply": {
		input: { id: string; approval: string };
		output: { revision: string; restartRequired: true };
	};
	"providers.receipt": {
		input: { provider: string; requestId: string };
		output: ProviderActionReceipt;
	};
	"providers.actions": {
		input: { provider: string };
		output: ProviderActionReceipt[];
	};
	"providers.preview": {
		input: ProviderActionIntent;
		output: ProviderActionCandidate;
	};
	"providers.apply": {
		input: { id: string; approval: string };
		output: ProviderActionReceipt;
	};
	"providers.read": { input: Data; output: ProviderSummary[] };
	/** Restored v1 provider workbench (direct developer actions). */
	"providers.workbench": {
		input: { operation: string; app?: string } & Data;
		output: unknown;
	};
	"providers.inspect": { input: ProviderQuery; output: ProviderInspection };
} & StandaloneMethods;
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
	"viewpoints.read",
	"viewpoints.save",
	"viewpoints.remove",
	"state.read",
	"state.subscribe",
	"session.read",
	"session.context",
	"session.history",
	"session.watch",
	"standalone.read",
	"standalone.create",
	"standalone.send",
	"standalone.abort",
	"standalone.compact",
	"standalone.configure",
	"standalone.retire",
	"session.send",
	"session.abort",
	"session.compact",
	"session.configure",
	"evidence.read",
	"task.read",
	"task.cancel",
	"review.decide",
	"schedule.delete",
	"schedule.create",
	"schedule.state",
	"telemetry.filters.read",
	"telemetry.trace.resolve",
	"telemetry.read",
	"telemetry.manage",
	"telemetry.collector.read",
	"telemetry.collector.start",
	"telemetry.collector.stop",
	"telemetry.receiver.read",
	"telemetry.receiver.start",
	"telemetry.receiver.stop",
	"environment.inspect",
	"environment.preview",
	"environment.apply",
	"environment.action",
	"environment.stop",
	"environment.git",
	"environment.cluster",
	"environment.tasks",
	"environment.apps",
	"environment.logs.analyze",
	"environment.stats",
	"environment.logs",
	"wiki.list",
	"wiki.read",
	"wiki.preview",
	"wiki.save",
	"wiki.apply",
	"wiki.comment",
	"skill-file.read",
	"skill-file.preview",
	"skill-file.apply",
	"skills.read",
	"skill.read",
	"settings.read",
	"settings.models",
	"settings.profile",
	"settings.save",
	"settings.preview",
	"settings.apply",
	"providers.receipt",
	"providers.actions",
	"providers.preview",
	"providers.apply",
	"providers.read",
	"providers.inspect",
	"providers.workbench",
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
