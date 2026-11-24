export type EnvironmentKind = "app" | "library" | "infrastructure" | string;
export type TargetAction = "build" | "test" | "run" | string;

export type DependencyRef = {
	service?: string;
	app?: string;
	target?: string;
	lifecycle?: string;
	runtime?: string;
	profile?: string;
};

export type PrerequisiteRef = { app: string; target: string };

export type EnvironmentTarget = {
	id: string;
	action: TargetAction;
	runtime: string;
	profile?: string;
	dependsOn: readonly DependencyRef[];
	prerequisites: readonly PrerequisiteRef[];
	endpoints: Readonly<Record<string, string>>;
	endpointServices: Readonly<Record<string, string>>;
};

export type EnvironmentApp = {
	id: string;
	repository: string;
	kind: EnvironmentKind;
	defaults: Readonly<Record<string, string | undefined>>;
	targets: readonly EnvironmentTarget[];
};

export type SharedLease = {
	scope?: string;
	app?: string;
	target?: string;
	acquiredAt?: number;
};

export type SharedService = {
	service?: string;
	state?: string;
	operation?: string;
	scope?: string;
	containers?: readonly string[];
	socket?: string;
	provider?: string;
	startedAt?: number;
	leases?: readonly SharedLease[];
};

export type EnvironmentService = {
	id: string;
	runtime?: string;
	start?: { app: string; target: string };
	readiness?: string;
	shared?: SharedService | null;
};

export type OwnedResource = {
	id: string;
	app: string;
	kind: string;
	runtimeId: string;
	createdAt: number;
	target?: string;
	repository?: string;
};

export type EnvironmentScope = {
	id: string;
	state: string;
	revision: number;
	repository?: string;
	owned?: number;
};

export type EnvironmentStatus = {
	scope?: { id: string; state: string; revision: number };
	scopes?: readonly EnvironmentScope[];
	owned?: readonly OwnedResource[];
	authority?: string;
};

export type GitChangeKind =
	| "modified"
	| "added"
	| "deleted"
	| "renamed"
	| "copied"
	| "conflicted"
	| "untracked";

export type GitChange = {
	path: string;
	originalPath?: string;
	kind: GitChangeKind;
	staged: boolean;
	worktree: boolean;
};

export type GitChanges = {
	repository: string;
	changes: readonly GitChange[];
	truncated: boolean;
	note?: string;
};

export type GitDiff = {
	repository: string;
	path: string;
	diff: string;
	binary: boolean;
	truncated: boolean;
	note?: string;
};

export type GitStatus = {
	repository: string;
	state: "clean" | "dirty" | "unknown";
	branch?: string;
	head?: string;
	detached?: boolean;
	ahead: number;
	behind: number;
	modified: number;
	added: number;
	deleted: number;
	changed: number;
	upstream?: string;
	reason?: string;
};

export type OperationSubject = {
	app: string;
	target: string;
	action?: string;
	repository?: string;
};

export type OperationSummary = {
	id: string;
	scope: string;
	kind: string;
	digest: string;
	state: string;
	revision: number;
	createdAt: number;
	inspectionRequired: boolean;
	historical: boolean;
	hasResult?: boolean;
	subject?: OperationSubject;
};

export type OperationProgress = {
	offset: number;
	text: string;
	reset?: boolean;
};

export type OperationDetail = OperationSummary & {
	result?: string;
	progress?: OperationProgress;
};

export type ExecutionReceipt = Record<string, unknown>;

export type LogsSnapshot = {
	app: string;
	tail: number;
	historical: boolean;
	retainedAt?: number;
	output: string;
};

export type TelemetryLog = {
	time?: number;
	severity?: string;
	body?: string;
	traceId?: string;
	spanId?: string;
};

export type TelemetryTrace = {
	traceId: string;
	root: string;
	spanCount: number;
	errors: number;
	startTime?: number;
	endTime?: number;
};

export type TelemetrySnapshot = {
	raw: Record<string, unknown>;
	app: string;
	transport?: string;
	bytes?: number;
	repository?: string;
	logs: readonly TelemetryLog[];
	traces: readonly TelemetryTrace[];
};

export type EnvironmentTab =
	| "applications"
	| "libraries"
	| "infrastructure"
	| "history"
	| "services";

export type EnvironmentView =
	| "table"
	| "detail"
	| "targets"
	| "operation"
	| "history"
	| "logs"
	| "telemetry"
	| "services"
	| "changes"
	| "diff";

export const TAB_ORDER: readonly EnvironmentTab[] = [
	"applications",
	"libraries",
	"infrastructure",
	"history",
	"services",
];

export const TAB_LABELS: Readonly<Record<EnvironmentTab, string>> = {
	applications: "Applications",
	libraries: "Libraries",
	infrastructure: "Infrastructure",
	history: "History",
	services: "Services",
};

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
const values = (value: unknown): readonly unknown[] =>
	Array.isArray(value) ? value : [];
const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;
const number = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;
const boolean = (value: unknown): boolean | undefined =>
	typeof value === "boolean" ? value : undefined;
const stringRecord = (value: unknown): Record<string, string> => {
	const source = record(value);
	if (!source) return {};
	return Object.fromEntries(
		Object.entries(source).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
};

function parseDependency(raw: unknown): DependencyRef | undefined {
	if (typeof raw === "string") return { service: raw };
	const value = record(raw);
	if (!value) return undefined;
	return {
		...(text(value.service) ? { service: text(value.service) } : {}),
		...(text(value.app) ? { app: text(value.app) } : {}),
		...(text(value.target) ? { target: text(value.target) } : {}),
		...(text(value.lifecycle) ? { lifecycle: text(value.lifecycle) } : {}),
		...(text(value.runtime) ? { runtime: text(value.runtime) } : {}),
		...(text(value.profile) ? { profile: text(value.profile) } : {}),
	};
}

function parsePrerequisite(raw: unknown): PrerequisiteRef | undefined {
	const value = record(raw);
	const app = value ? text(value.app) : undefined;
	const target = value ? text(value.target) : undefined;
	return app && target ? { app, target } : undefined;
}

export function parseTarget(raw: unknown): EnvironmentTarget | undefined {
	const value = record(raw);
	const id = value ? text(value.id) : undefined;
	if (!value || !id) return undefined;
	return {
		id,
		action: text(value.action) ?? "run",
		runtime: text(value.runtime) ?? "unknown",
		...(text(value.profile) ? { profile: text(value.profile) } : {}),
		dependsOn: values(value.dependsOn)
			.map(parseDependency)
			.filter((entry): entry is DependencyRef => Boolean(entry)),
		prerequisites: values(value.prerequisites)
			.map(parsePrerequisite)
			.filter((entry): entry is PrerequisiteRef => Boolean(entry)),
		endpoints: stringRecord(value.endpoints),
		endpointServices: stringRecord(value.endpointServices),
	};
}

export function parseApp(raw: unknown): EnvironmentApp | undefined {
	const value = record(raw);
	const id = value ? text(value.id) : undefined;
	if (!value || !id) return undefined;
	const defaults = record(value.defaults);
	return {
		id,
		repository: text(value.repository) ?? "",
		kind: text(value.kind) ?? "app",
		defaults: defaults
			? Object.fromEntries(
					Object.entries(defaults).map(([key, item]) => [
						key,
						typeof item === "string" ? item : undefined,
					]),
				)
			: {},
		targets: values(value.targets)
			.map(parseTarget)
			.filter((entry): entry is EnvironmentTarget => Boolean(entry)),
	};
}

function parseLease(raw: unknown): SharedLease | undefined {
	const value = record(raw);
	if (!value) return undefined;
	return {
		...(text(value.scope) ? { scope: text(value.scope) } : {}),
		...(text(value.app) ? { app: text(value.app) } : {}),
		...(text(value.target) ? { target: text(value.target) } : {}),
		...(number(value.acquiredAt) !== undefined
			? { acquiredAt: number(value.acquiredAt) }
			: {}),
	};
}

function parseShared(raw: unknown): SharedService | null {
	const value = record(raw);
	if (!value) return null;
	return {
		...(text(value.service) ? { service: text(value.service) } : {}),
		...(text(value.state) ? { state: text(value.state) } : {}),
		...(text(value.operation) ? { operation: text(value.operation) } : {}),
		...(text(value.scope) ? { scope: text(value.scope) } : {}),
		...(Array.isArray(value.containers)
			? {
					containers: values(value.containers).filter(
						(item): item is string => typeof item === "string",
					),
				}
			: {}),
		...(text(value.socket) ? { socket: text(value.socket) } : {}),
		...(text(value.provider) ? { provider: text(value.provider) } : {}),
		...(number(value.startedAt) !== undefined
			? { startedAt: number(value.startedAt) }
			: {}),
		...(Array.isArray(value.leases)
			? {
					leases: values(value.leases)
						.map(parseLease)
						.filter((entry): entry is SharedLease => Boolean(entry)),
				}
			: {}),
	};
}

export function parseService(raw: unknown): EnvironmentService | undefined {
	const value = record(raw);
	const id = value ? text(value.id) : undefined;
	if (!value || !id) return undefined;
	const start = record(value.start);
	const startApp = start ? text(start.app) : undefined;
	const startTarget = start ? text(start.target) : undefined;
	return {
		id,
		...(text(value.runtime) ? { runtime: text(value.runtime) } : {}),
		...(startApp && startTarget
			? { start: { app: startApp, target: startTarget } }
			: {}),
		...(text(value.readiness) ? { readiness: text(value.readiness) } : {}),
		...(value.shared === null
			? { shared: null }
			: parseShared(value.shared)
				? { shared: parseShared(value.shared) }
				: {}),
	};
}

const gitChangeKinds = new Set<GitChangeKind>([
	"modified",
	"added",
	"deleted",
	"renamed",
	"copied",
	"conflicted",
	"untracked",
]);

export function parseGitChange(raw: unknown): GitChange | undefined {
	const value = record(raw);
	const path = value ? text(value.path) : undefined;
	if (!value || !path) return undefined;
	const kind =
		typeof value.kind === "string" &&
		gitChangeKinds.has(value.kind as GitChangeKind)
			? (value.kind as GitChangeKind)
			: "modified";
	return {
		path,
		...(text(value.originalPath)
			? { originalPath: text(value.originalPath) }
			: {}),
		kind,
		staged: boolean(value.staged) ?? false,
		worktree: boolean(value.worktree) ?? false,
	};
}

export function parseGitChanges(raw: Record<string, unknown>): GitChanges {
	return {
		repository: text(raw.repository) ?? "",
		changes: values(raw.changes)
			.map(parseGitChange)
			.filter((entry): entry is GitChange => Boolean(entry)),
		truncated: boolean(raw.truncated) ?? false,
		...(text(raw.note) ? { note: text(raw.note) } : {}),
	};
}

export function parseGitDiff(raw: Record<string, unknown>): GitDiff {
	return {
		repository: text(raw.repository) ?? "",
		path: text(raw.path) ?? "",
		diff: typeof raw.diff === "string" ? raw.diff : "",
		binary: boolean(raw.binary) ?? false,
		truncated: boolean(raw.truncated) ?? false,
		...(text(raw.note) ? { note: text(raw.note) } : {}),
	};
}

export function parseGitStatus(raw: unknown): GitStatus | undefined {
	const value = record(raw);
	const repository = value ? text(value.repository) : undefined;
	if (!value || !repository) return undefined;
	const state =
		value.state === "clean" || value.state === "dirty"
			? value.state
			: "unknown";
	return {
		repository,
		state,
		...(text(value.branch) ? { branch: text(value.branch) } : {}),
		...(text(value.head) ? { head: text(value.head) } : {}),
		...(boolean(value.detached) ? { detached: true } : {}),
		ahead: number(value.ahead) ?? 0,
		behind: number(value.behind) ?? 0,
		modified: number(value.modified) ?? number(value.changed) ?? 0,
		added: number(value.added) ?? 0,
		deleted: number(value.deleted) ?? 0,
		changed: number(value.changed) ?? 0,
		...(text(value.upstream) ? { upstream: text(value.upstream) } : {}),
		...(text(value.reason) ? { reason: text(value.reason) } : {}),
	};
}

export function parseGitStatuses(raw: Record<string, unknown>) {
	return values(raw.repositories)
		.map(parseGitStatus)
		.filter((entry): entry is GitStatus => Boolean(entry));
}

export function parseOwned(raw: unknown): OwnedResource | undefined {
	const value = record(raw);
	const id = value ? text(value.id) : undefined;
	const app = value ? text(value.app) : undefined;
	if (!value || !id || !app) return undefined;
	return {
		id,
		app,
		kind: text(value.kind) ?? "resource",
		runtimeId: text(value.runtimeId) ?? "",
		createdAt: number(value.createdAt) ?? 0,
		...(text(value.target) ? { target: text(value.target) } : {}),
		...(text(value.repository) ? { repository: text(value.repository) } : {}),
	};
}

export function parseScope(raw: unknown): EnvironmentScope | undefined {
	const value = record(raw);
	const id = value ? text(value.id) : undefined;
	if (!value || !id) return undefined;
	return {
		id,
		state: text(value.state) ?? "unknown",
		revision: number(value.revision) ?? 0,
		...(text(value.repository) ? { repository: text(value.repository) } : {}),
		...(number(value.owned) !== undefined
			? { owned: number(value.owned) }
			: {}),
	};
}

export function parseStatus(raw: Record<string, unknown>): EnvironmentStatus {
	const scope = record(raw.scope);
	const scopeId = scope ? text(scope.id) : undefined;
	return {
		...(scope && scopeId
			? {
					scope: {
						id: scopeId,
						state: text(scope.state) ?? "unknown",
						revision: number(scope.revision) ?? 0,
					},
				}
			: {}),
		...(Array.isArray(raw.scopes)
			? {
					scopes: values(raw.scopes)
						.map(parseScope)
						.filter((entry): entry is EnvironmentScope => Boolean(entry)),
				}
			: {}),
		...(Array.isArray(raw.owned)
			? {
					owned: values(raw.owned)
						.map(parseOwned)
						.filter((entry): entry is OwnedResource => Boolean(entry)),
				}
			: {}),
		...(text(raw.authority) ? { authority: text(raw.authority) } : {}),
	};
}

export function parseSubject(raw: unknown): OperationSubject | undefined {
	const value = record(raw);
	const app = value ? text(value.app) : undefined;
	const target = value ? text(value.target) : undefined;
	if (!value || !app || !target) return undefined;
	return {
		app,
		target,
		...(text(value.action) ? { action: text(value.action) } : {}),
		...(text(value.repository) ? { repository: text(value.repository) } : {}),
	};
}

export function parseOperation(raw: unknown): OperationSummary | undefined {
	const value = record(raw);
	const id = value ? text(value.id) : undefined;
	if (!value || !id) return undefined;
	return {
		id,
		scope: text(value.scope) ?? "",
		kind: text(value.kind) ?? "executable",
		digest: text(value.digest) ?? "",
		state: text(value.state) ?? "unknown",
		revision: number(value.revision) ?? 0,
		createdAt: number(value.createdAt) ?? 0,
		inspectionRequired: boolean(value.inspectionRequired) ?? false,
		historical: boolean(value.historical) ?? false,
		...(boolean(value.hasResult) !== undefined
			? { hasResult: boolean(value.hasResult) }
			: {}),
		...(parseSubject(value.subject)
			? { subject: parseSubject(value.subject) }
			: {}),
	};
}

export function parseOperationDetail(
	raw: Record<string, unknown>,
): OperationDetail {
	const summary = parseOperation(raw);
	const progress = record(raw.progress);
	return {
		...(summary ?? {
			id: text(raw.id) ?? "unknown",
			scope: "",
			kind: "executable",
			digest: "",
			state: "unknown",
			revision: 0,
			createdAt: 0,
			inspectionRequired: false,
			historical: false,
		}),
		...(text(raw.result) ? { result: text(raw.result) } : {}),
		...(progress
			? {
					progress: {
						offset: number(progress.offset) ?? 0,
						text: typeof progress.text === "string" ? progress.text : "",
						...(boolean(progress.reset) ? { reset: true } : {}),
					},
				}
			: {}),
	};
}

export function parseLogs(raw: Record<string, unknown>): LogsSnapshot {
	return {
		app: text(raw.app) ?? "app",
		tail: number(raw.tail) ?? 0,
		historical: boolean(raw.historical) ?? false,
		...(number(raw.retainedAt) !== undefined
			? { retainedAt: number(raw.retainedAt) }
			: {}),
		output: text(raw.output) ?? "",
	};
}

export function parseTelemetryTrace(raw: unknown): TelemetryTrace | undefined {
	const value = record(raw);
	const traceId = value ? text(value.traceId) : undefined;
	if (!value || !traceId) return undefined;
	return {
		traceId,
		root: text(value.root) ?? "(unnamed)",
		spanCount: number(value.spanCount) ?? 0,
		errors: number(value.errors) ?? 0,
		...(number(value.startTime) !== undefined
			? { startTime: number(value.startTime) }
			: {}),
		...(number(value.endTime) !== undefined
			? { endTime: number(value.endTime) }
			: {}),
	};
}

export function parseTelemetryLog(raw: unknown): TelemetryLog | undefined {
	const value = record(raw);
	if (!value) return undefined;
	return {
		...(number(value.time) !== undefined ? { time: number(value.time) } : {}),
		...(text(value.severity) ? { severity: text(value.severity) } : {}),
		...(text(value.body) ? { body: text(value.body) } : {}),
		...(text(value.traceId) ? { traceId: text(value.traceId) } : {}),
		...(text(value.spanId) ? { spanId: text(value.spanId) } : {}),
	};
}

export function parseTelemetry(
	raw: Record<string, unknown>,
): TelemetrySnapshot {
	return {
		raw,
		app: text(raw.app) ?? "app",
		...(text(raw.transport) ? { transport: text(raw.transport) } : {}),
		...(number(raw.bytes) !== undefined ? { bytes: number(raw.bytes) } : {}),
		...(text(raw.repository) ? { repository: text(raw.repository) } : {}),
		logs: values(raw.logs)
			.map(parseTelemetryLog)
			.filter((entry): entry is TelemetryLog => Boolean(entry)),
		traces: values(raw.traces)
			.map(parseTelemetryTrace)
			.filter((entry): entry is TelemetryTrace => Boolean(entry)),
	};
}

export function parseList(raw: Record<string, unknown>) {
	return {
		apps: values(raw.apps)
			.map(parseApp)
			.filter((entry): entry is EnvironmentApp => Boolean(entry)),
		services: values(raw.services)
			.map(parseService)
			.filter((entry): entry is EnvironmentService => Boolean(entry)),
		repositories: values(raw.repositories).filter(
			(item): item is string => typeof item === "string",
		),
		total: number(raw.total) ?? 0,
		nextOffset: number(raw.nextOffset) ?? null,
	};
}

export function parseHistory(raw: Record<string, unknown>) {
	return {
		operations: values(raw.operations)
			.map(parseOperation)
			.filter((entry): entry is OperationSummary => Boolean(entry)),
		total: number(raw.total) ?? 0,
		nextOffset: number(raw.nextOffset) ?? null,
	};
}

export function parseExecution(raw: Record<string, unknown>) {
	const operation = parseOperation(raw.operation);
	return {
		operation,
		receipt: record(raw.receipt) ?? null,
	};
}

export function parseStop(raw: Record<string, unknown>) {
	return {
		stopped: values(raw.stopped).filter(
			(item): item is string => typeof item === "string",
		),
		remaining: number(raw.remaining) ?? 0,
		retainedLogsAvailable: boolean(raw.retainedLogsAvailable) ?? false,
	};
}

export function filterApps(
	apps: readonly EnvironmentApp[],
	query: string,
): readonly EnvironmentApp[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return apps;
	return apps.filter((app) => {
		const haystack = [
			app.id,
			app.repository,
			app.kind,
			...app.targets.flatMap((target) => [
				target.id,
				target.action,
				target.runtime,
				target.profile ?? "",
			]),
		]
			.join(" ")
			.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
}

export function appsForTab(
	apps: readonly EnvironmentApp[],
	tab: EnvironmentTab,
): readonly EnvironmentApp[] {
	if (tab === "history" || tab === "services") return [];
	const kind =
		tab === "applications"
			? "app"
			: tab === "libraries"
				? "library"
				: "infrastructure";
	return apps.filter((app) => app.kind === kind);
}

export function tabCounts(
	apps: readonly EnvironmentApp[],
): Readonly<Record<EnvironmentTab, number>> {
	return {
		applications: apps.filter((app) => app.kind === "app").length,
		libraries: apps.filter((app) => app.kind === "library").length,
		infrastructure: apps.filter((app) => app.kind === "infrastructure").length,
		history: 0,
		services: 0,
	};
}

export function targetsFor(
	app: EnvironmentApp | undefined,
	action: TargetAction,
): readonly EnvironmentTarget[] {
	return app ? app.targets.filter((target) => target.action === action) : [];
}

export function defaultTarget(
	app: EnvironmentApp | undefined,
	action: TargetAction,
): EnvironmentTarget | undefined {
	if (!app) return undefined;
	const id = app.defaults[action];
	const byDefault = id
		? app.targets.find((target) => target.id === id)
		: undefined;
	return byDefault ?? app.targets.find((target) => target.action === action);
}

export function targetLabel(target: EnvironmentTarget): string {
	return [
		target.id,
		target.runtime,
		target.profile ? `profile ${target.profile}` : undefined,
	]
		.filter(Boolean)
		.join(" · ");
}

export function actionGlyph(action: string): string {
	if (action === "build") return "⚒";
	if (action === "test") return "✓";
	if (action === "run") return "▶";
	return "•";
}

export function targetSummary(app: EnvironmentApp): string {
	const counts = new Map<string, number>();
	for (const target of app.targets)
		counts.set(target.action, (counts.get(target.action) ?? 0) + 1);
	return ["build", "test", "run"]
		.flatMap((action) => {
			const count = counts.get(action);
			if (!count) return [];
			return [`${actionGlyph(action)}${count > 1 ? String(count) : ""}`];
		})
		.join(" ");
}

export function ownedFor(
	status: EnvironmentStatus,
	app: string,
): readonly OwnedResource[] {
	return (status.owned ?? []).filter((resource) => resource.app === app);
}

export function scopeLabel(status: EnvironmentStatus): string {
	if (status.scopes?.length) {
		const active = status.scopes.filter((scope) => scope.state === "active");
		return `${active.length}/${status.scopes.length} scopes active`;
	}
	return status.scope?.state ?? "unknown";
}

export function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const index = trimmed.lastIndexOf("/");
	return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

export function formatTimestamp(value: number | undefined): string {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString(undefined, {
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function shortId(value: string): string {
	return value.length > 12 ? value.slice(0, 12) : value;
}

export function prettyJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function receiptText(receipt: ExecutionReceipt): string {
	const output = receipt.output;
	if (typeof output === "string" && output.length > 0) return output;
	return prettyJson(receipt);
}
