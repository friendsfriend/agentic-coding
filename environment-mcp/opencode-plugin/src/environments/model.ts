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

export type GitActionKind =
	| "fetch"
	| "pull"
	| "checkout"
	| "branch-delete"
	| "remote-add"
	| "remote-remove"
	| "worktree-add"
	| "worktree-remove";

export type GitActionRequest =
	| { action: "fetch" }
	| { action: "pull" }
	| { action: "checkout"; branch: string }
	| { action: "branch-delete"; branch: string }
	| { action: "remote-add"; name: string; url: string }
	| { action: "remote-remove"; name: string }
	| { action: "stage"; path: string }
	| { action: "unstage"; path: string }
	| { action: "stage-all" }
	| { action: "unstage-all" }
	| {
			action: "worktree-add";
			path: string;
			branch: string;
			create: boolean;
	  }
	| { action: "worktree-remove"; path: string };

export type GitCommit = {
	sha: string;
	shortSha: string;
	subject: string;
	author: string;
	date?: string;
	refs?: readonly string[];
};

export type GitCommitFile = {
	path: string;
	additions?: number;
	deletions?: number;
	binary?: boolean;
};

export type GitCommitDetail = GitCommit & {
	email?: string;
	parents: readonly string[];
	body: string;
	files: readonly GitCommitFile[];
	diff: string;
	truncated: boolean;
	note?: string;
};

export type GitLog = {
	repository: string;
	commits: readonly GitCommit[];
	note?: string;
};

export type GitTags = {
	repository: string;
	tags: readonly {
		name: string;
		sha: string;
		annotated: boolean;
		date?: string;
		subject?: string;
	}[];
	note?: string;
};

export type GitStashes = {
	repository: string;
	stashes: readonly {
		index: number;
		ref: string;
		branch?: string;
		message: string;
		date?: string;
	}[];
	note?: string;
};

export type GitWriteRequest =
	| {
			action: "push";
			branch: string;
			remote: string;
			setUpstream: boolean;
	  }
	| {
			action: "push-force";
			branch: string;
			remote: string;
	  }
	| { action: "tag"; name: string; message?: string }
	| { action: "tag-delete"; name: string }
	| { action: "stash-pop"; index: number }
	| { action: "stash-apply"; index: number }
	| { action: "stash-drop"; index: number }
	| { action: "branch-rename"; branch: string; name: string }
	| { action: "remote-set-url"; name: string; url: string }
	| { action: "commit"; message: string }
	| { action: "commit-all"; message: string }
	| { action: "stash"; message?: string }
	| { action: "merge"; branch: string }
	| { action: "rebase"; branch: string }
	| { action: "rebase-abort" };

export type GitWriteOutcome =
	| {
			status: "confirmation-required";
			digest: string;
			intent: {
				repository: string;
				action: string;
				target: string;
			};
	  }
	| {
			status: "completed" | "replayed";
			digest: string;
			outcome: GitActionOutcome;
	  };

export type GitBranch = {
	name: string;
	current: boolean;
	upstream?: string;
	ahead: number;
	behind: number;
	gone?: boolean;
};

export type GitBranches = {
	repository: string;
	branches: readonly GitBranch[];
	current?: string;
	note?: string;
};

export type GitWorktree = {
	path: string;
	head?: string;
	branch?: string;
	detached: boolean;
	bare: boolean;
	current: boolean;
	locked?: string;
	prunable?: string;
};

export type GitWorktrees = {
	repository: string;
	worktrees: readonly GitWorktree[];
	note?: string;
};

export type ProviderSummary = {
	name: string;
	type: string;
	baseUrl: string;
	username: string;
	hasToken: boolean;
};

export type ProviderRepository = {
	reference: string;
	name: string;
	description: string;
	url: string;
	defaultBranch?: string;
};

export type ProviderRepositoryMatch = {
	provider: string;
	type: string;
	reference: string;
	host: string;
	url: string;
};

export type ProviderChange = {
	id: string;
	number: number;
	title: string;
	state: string;
	sourceBranch: string;
	targetBranch: string;
	author: string;
	url: string;
};

export type ProviderIssue = {
	id: string;
	number: number;
	title: string;
	state: string;
	author: string;
	labels: readonly string[];
	url: string;
};

export type ProviderPipeline = {
	id: number;
	name: string;
	status: string;
	conclusion?: string;
	ref?: string;
	url: string;
	updatedAt?: string;
};

export type ProviderJob = {
	id: number;
	name: string;
	status: string;
	conclusion?: string;
	stage?: string;
	url: string;
};

export type ProviderChangeDetail = ProviderChange & {
	body: string;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	headSha?: string;
	createdAt?: string;
	updatedAt?: string;
	mergedAt?: string;
};

export type ProviderFile = {
	path: string;
	status: string;
	additions?: number;
	deletions?: number;
	patch: string;
};

export type ProviderFiles = {
	files: readonly ProviderFile[];
	truncated: boolean;
	note?: string;
};

export type ProviderVersion = {
	sha: string;
	message: string;
	author?: string;
	date?: string;
};

export type ProviderIssueDetail = ProviderIssue & {
	body: string;
	createdAt?: string;
	updatedAt?: string;
};

export type ProviderDiscussion = {
	id: string;
	threadId?: string;
	author: string;
	body: string;
	url?: string;
	createdAt?: string;
	resolved?: boolean;
};

export type ProviderJobLogs = {
	output: string;
	truncated: boolean;
};

export type ProviderWriteAction =
	| "comment-change"
	| "comment-issue"
	| "approve-change"
	| "merge-change"
	| "set-issue-state"
	| "rebase-change"
	| "unapprove-change"
	| "reply-discussion"
	| "set-discussion-resolved"
	| "add-labels"
	| "set-assignees"
	| "retry-pipeline"
	| "retry-job"
	| "cancel-pipeline";

export type ProviderWriteReceipt = {
	requestId: string;
	provider: string;
	action: ProviderWriteAction;
	target: string;
	digest: string;
	state: "attempting" | "completed" | "failed";
	createdAt: number;
	updatedAt: number;
	result?: Readonly<Record<string, unknown>>;
	error?: string;
};

export type ProviderWriteOutcome =
	| {
			status: "confirmation-required";
			digest: string;
			intent: {
				provider: string;
				action: ProviderWriteAction;
				target: string;
			};
	  }
	| {
			status: "completed" | "replayed";
			digest: string;
			receipt: ProviderWriteReceipt;
	  };

export type ConfigurationRevision = {
	digest: string;
	apps: number;
	targets: number;
	repositories: readonly string[];
};

export type ConfigurationPreview = {
	status: "confirmation-required";
	expectedDigest: string;
	nextDigest: string;
	confirm: string;
	summary: string;
};

export type ConfigurationApplyResult = {
	status: "completed";
	digest: string;
	summary: string;
};

export type ConfigurationMutationResult =
	| ConfigurationPreview
	| ConfigurationApplyResult;

export type ContainerStatsEntry = {
	container: string;
	repository?: string;
	app?: string;
	service?: string;
	provider: "docker" | "podman" | string;
	cpuPercent?: number;
	memoryUsageBytes?: number;
	memoryLimitBytes?: number;
	memoryPercent?: number;
	networkRxBytes?: number;
	networkTxBytes?: number;
	pids?: number;
	readAt?: string;
};

export type ContainerStatsResult = {
	containers: readonly ContainerStatsEntry[];
	unavailable: number;
	note: string;
};

export type KubernetesClusterInfo = {
	id: string;
	context: string;
	repositories: readonly string[];
};

export type KubernetesResource = {
	kind: string;
	name: string;
	status: string;
	ready?: string;
	restarts?: number;
	containers?: readonly string[];
	age?: string;
	createdAt?: string;
};

export type KubernetesResources = {
	cluster: string;
	namespace: string;
	output: string;
	truncated: boolean;
	items: readonly KubernetesResource[];
};

export type KubernetesEvent = {
	type: string;
	reason: string;
	object: string;
	message: string;
	count?: number;
	lastTimestamp?: string;
};

export type KubernetesNamespaces = {
	cluster: string;
	namespaces: readonly string[];
};

export type KubernetesEvents = {
	cluster: string;
	namespace: string;
	output: string;
	truncated: boolean;
	events: readonly KubernetesEvent[];
};

export type KubernetesDescribe = {
	cluster: string;
	namespace: string;
	kind: string;
	name: string;
	output: string;
	truncated: boolean;
};

export type KubernetesPodLogs = {
	cluster: string;
	namespace: string;
	pod: string;
	container?: string;
	previous?: boolean;
	output: string;
	truncated: boolean;
};

export type GitRemote = {
	name: string;
	fetchUrl: string;
	pushUrl?: string;
};

export type GitRemotes = {
	repository: string;
	remotes: readonly GitRemote[];
	note?: string;
};

export type GitActionOutcome = {
	repository: string;
	action: string;
	status: "completed" | "refused" | "failed";
	output: string;
	truncated: boolean;
	reason?: string;
	branch?: string;
	path?: string;
	head?: string;
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

export type GitDiffSide = "all" | "staged" | "worktree";

export type GitDiff = {
	repository: string;
	path: string;
	side: GitDiffSide;
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
	worktree?: string;
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
	| "diff"
	| "git"
	| "worktrees"
	| "worktree-add"
	| "remotes"
	| "remote-add"
	| "providers"
	| "provider-repos"
	| "provider-changes"
	| "provider-issues"
	| "provider-pipelines"
	| "provider-jobs"
	| "provider-change"
	| "provider-change-files"
	| "provider-file"
	| "provider-change-discussions"
	| "provider-issue"
	| "provider-job-logs"
	| "provider-issue-comments"
	| "provider-versions"
	| "container-stats"
	| "clusters"
	| "cluster-namespace"
	| "cluster-resources"
	| "cluster-events"
	| "cluster-describe"
	| "cluster-pod-logs"
	| "cluster-pod-containers"
	| "provider-merge"
	| "provider-write"
	| "provider-writes"
	| "git-write"
	| "git-log"
	| "git-commit"
	| "tags"
	| "tag-add"
	| "stashes"
	| "config-write";

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

export function parseGitBranches(raw: Record<string, unknown>): GitBranches {
	return {
		repository: text(raw.repository) ?? "",
		branches: values(raw.branches).flatMap((entry) => {
			const value = record(entry);
			const name = value ? text(value.name) : undefined;
			if (!value || !name) return [];
			return [
				{
					name,
					current: boolean(value.current) ?? false,
					...(text(value.upstream) ? { upstream: text(value.upstream) } : {}),
					ahead: number(value.ahead) ?? 0,
					behind: number(value.behind) ?? 0,
					...(boolean(value.gone) ? { gone: true } : {}),
				},
			];
		}),
		...(text(raw.current) ? { current: text(raw.current) } : {}),
		...(text(raw.note) ? { note: text(raw.note) } : {}),
	};
}

export function parseGitWorktrees(raw: Record<string, unknown>): GitWorktrees {
	return {
		repository: text(raw.repository) ?? "",
		worktrees: values(raw.worktrees).flatMap((entry) => {
			const value = record(entry);
			const worktreePath = value ? text(value.path) : undefined;
			if (!value || !worktreePath) return [];
			return [
				{
					path: worktreePath,
					...(text(value.head) ? { head: text(value.head) } : {}),
					...(text(value.branch) ? { branch: text(value.branch) } : {}),
					detached: boolean(value.detached) ?? false,
					bare: boolean(value.bare) ?? false,
					current: boolean(value.current) ?? false,
					...(text(value.locked) ? { locked: text(value.locked) } : {}),
					...(text(value.prunable) ? { prunable: text(value.prunable) } : {}),
				},
			];
		}),
		...(text(raw.note) ? { note: text(raw.note) } : {}),
	};
}

export function parseProviders(
	raw: Record<string, unknown>,
): ProviderSummary[] {
	return values(raw.providers).flatMap((entry) => {
		const value = record(entry);
		const name = value ? text(value.name) : undefined;
		const type = value ? text(value.type) : undefined;
		if (!value || !name || !type) return [];
		return [
			{
				name,
				type,
				baseUrl: text(value.baseUrl) ?? "",
				username: text(value.username) ?? "",
				hasToken: value.hasToken === true,
			},
		];
	});
}

export function parseProviderRepositoryMatches(
	raw: Record<string, unknown>,
): ProviderRepositoryMatch[] {
	return values(raw.matches).flatMap((entry) => {
		const value = record(entry);
		const provider = value ? text(value.provider) : undefined;
		const reference = value ? text(value.reference) : undefined;
		if (!value || !provider || !reference) return [];
		return [
			{
				provider,
				type: text(value.type) ?? "",
				reference,
				host: text(value.host) ?? "",
				url: text(value.url) ?? "",
			},
		];
	});
}

export function parseProviderRepositories(
	raw: Record<string, unknown>,
): ProviderRepository[] {
	return values(raw.repositories).flatMap((entry) => {
		const value = record(entry);
		const reference = value ? text(value.reference) : undefined;
		if (!value || !reference) return [];
		return [
			{
				reference,
				name: text(value.name) ?? reference,
				description: text(value.description) ?? "",
				url: text(value.url) ?? "",
				...(text(value.defaultBranch)
					? { defaultBranch: text(value.defaultBranch) }
					: {}),
			},
		];
	});
}

export function parseProviderChanges(
	raw: Record<string, unknown>,
): ProviderChange[] {
	return values(raw.changes).flatMap((entry) => {
		const value = record(entry);
		const changeNumber = value ? number(value.number) : undefined;
		if (!value || changeNumber === undefined) return [];
		return [
			{
				id: text(value.id) ?? `change-${changeNumber}`,
				number: changeNumber,
				title: text(value.title) ?? "",
				state: text(value.state) ?? "",
				sourceBranch: text(value.sourceBranch) ?? "",
				targetBranch: text(value.targetBranch) ?? "",
				author: text(value.author) ?? "",
				url: text(value.url) ?? "",
			},
		];
	});
}

export function parseProviderIssues(
	raw: Record<string, unknown>,
): ProviderIssue[] {
	return values(raw.issues).flatMap((entry) => {
		const value = record(entry);
		const issueNumber = value ? number(value.number) : undefined;
		if (!value || issueNumber === undefined) return [];
		return [
			{
				id: text(value.id) ?? `issue-${issueNumber}`,
				number: issueNumber,
				title: text(value.title) ?? "",
				state: text(value.state) ?? "",
				author: text(value.author) ?? "",
				labels: values(value.labels).flatMap((label) =>
					typeof label === "string" ? [label] : [],
				),
				url: text(value.url) ?? "",
			},
		];
	});
}

export function parseProviderPipelines(
	raw: Record<string, unknown>,
): ProviderPipeline[] {
	return values(raw.pipelines).flatMap((entry) => {
		const value = record(entry);
		const id = value ? number(value.id) : undefined;
		if (!value || id === undefined) return [];
		return [
			{
				id,
				name: text(value.name) ?? `pipeline ${id}`,
				status: text(value.status) ?? "",
				...(text(value.conclusion)
					? { conclusion: text(value.conclusion) }
					: {}),
				...(text(value.ref) ? { ref: text(value.ref) } : {}),
				url: text(value.url) ?? "",
				...(text(value.updatedAt) ? { updatedAt: text(value.updatedAt) } : {}),
			},
		];
	});
}

export function parseProviderJobs(raw: Record<string, unknown>): ProviderJob[] {
	return values(raw.jobs).flatMap((entry) => {
		const value = record(entry);
		const id = value ? number(value.id) : undefined;
		if (!value || id === undefined) return [];
		return [
			{
				id,
				name: text(value.name) ?? `job ${id}`,
				status: text(value.status) ?? "",
				...(text(value.conclusion)
					? { conclusion: text(value.conclusion) }
					: {}),
				...(text(value.stage) ? { stage: text(value.stage) } : {}),
				url: text(value.url) ?? "",
			},
		];
	});
}

export function parseProviderChangeDetail(
	raw: Record<string, unknown>,
): ProviderChangeDetail | undefined {
	const change = parseProviderChanges({ changes: [raw.change] })[0];
	if (!change) return undefined;
	const value = record(raw.change);
	if (!value) return undefined;
	return {
		...change,
		body: text(value.body) ?? "",
		...(number(value.additions) !== undefined
			? { additions: number(value.additions) }
			: {}),
		...(number(value.deletions) !== undefined
			? { deletions: number(value.deletions) }
			: {}),
		...(number(value.changedFiles) !== undefined
			? { changedFiles: number(value.changedFiles) }
			: {}),
		...(text(value.headSha) ? { headSha: text(value.headSha) } : {}),
		...(text(value.createdAt) ? { createdAt: text(value.createdAt) } : {}),
		...(text(value.updatedAt) ? { updatedAt: text(value.updatedAt) } : {}),
		...(text(value.mergedAt) ? { mergedAt: text(value.mergedAt) } : {}),
	};
}

export function parseProviderFiles(
	raw: Record<string, unknown>,
): ProviderFiles {
	return {
		files: values(raw.files).flatMap((entry) => {
			const value = record(entry);
			const path = value ? text(value.path) : undefined;
			if (!value || !path) return [];
			return [
				{
					path,
					status: text(value.status) ?? "modified",
					...(number(value.additions) !== undefined
						? { additions: number(value.additions) }
						: {}),
					...(number(value.deletions) !== undefined
						? { deletions: number(value.deletions) }
						: {}),
					patch: text(value.patch) ?? "",
				},
			];
		}),
		truncated: raw.truncated === true,
		...(text(raw.note) ? { note: text(raw.note) } : {}),
	};
}

export function parseProviderVersions(
	raw: Record<string, unknown>,
): ProviderVersion[] {
	return values(raw.versions).flatMap((entry) => {
		const value = record(entry);
		const sha = value ? text(value.sha) : undefined;
		if (!value || !sha) return [];
		return [
			{
				sha,
				message: text(value.message) ?? "",
				...(text(value.author) ? { author: text(value.author) } : {}),
				...(text(value.date) ? { date: text(value.date) } : {}),
			},
		];
	});
}

export function parseProviderIssueDetail(
	raw: Record<string, unknown>,
): ProviderIssueDetail | undefined {
	const issue = parseProviderIssues({ issues: [raw.issue] })[0];
	const value = record(raw.issue);
	if (!issue || !value) return undefined;
	return {
		...issue,
		body: text(value.body) ?? "",
		...(text(value.createdAt) ? { createdAt: text(value.createdAt) } : {}),
		...(text(value.updatedAt) ? { updatedAt: text(value.updatedAt) } : {}),
	};
}

export function parseProviderDiscussions(
	raw: Record<string, unknown>,
): ProviderDiscussion[] {
	return values(raw.discussions).flatMap((entry) => {
		const value = record(entry);
		const id = value ? text(value.id) : undefined;
		if (!value || !id) return [];
		return [
			{
				id,
				...(text(value.threadId) ? { threadId: text(value.threadId) } : {}),
				author: text(value.author) ?? "",
				body: text(value.body) ?? "",
				...(text(value.url) ? { url: text(value.url) } : {}),
				...(text(value.createdAt) ? { createdAt: text(value.createdAt) } : {}),
				...(typeof value.resolved === "boolean"
					? { resolved: value.resolved }
					: {}),
			},
		];
	});
}

export function parseProviderIssueComments(
	raw: Record<string, unknown>,
): ProviderDiscussion[] {
	return parseProviderDiscussions({ discussions: raw.comments });
}

export function parseProviderJobLogs(
	raw: Record<string, unknown>,
): ProviderJobLogs {
	return {
		output: text(raw.output) ?? "",
		truncated: raw.truncated === true,
	};
}

export function parseConfigurationRevision(
	raw: Record<string, unknown>,
): ConfigurationRevision {
	return {
		digest: text(raw.digest) ?? "",
		apps: number(raw.apps) ?? 0,
		targets: number(raw.targets) ?? 0,
		repositories: values(raw.repositories).flatMap((entry) =>
			typeof entry === "string" ? [entry] : [],
		),
	};
}

export function parseConfigurationMutation(
	raw: Record<string, unknown>,
): ConfigurationMutationResult | undefined {
	const status = text(raw.status);
	if (status === "confirmation-required") {
		const expectedDigest = text(raw.expectedDigest);
		const nextDigest = text(raw.nextDigest);
		const confirm = text(raw.confirm);
		const summary = text(raw.summary);
		if (!expectedDigest || !nextDigest || !confirm || !summary)
			return undefined;
		return { status, expectedDigest, nextDigest, confirm, summary };
	}
	if (status === "completed") {
		const digest = text(raw.digest);
		const summary = text(raw.summary);
		if (!digest || !summary) return undefined;
		return { status, digest, summary };
	}
	return undefined;
}

export function parseContainerStats(
	raw: Record<string, unknown>,
): ContainerStatsResult {
	return {
		containers: values(raw.containers).flatMap((entry) => {
			const value = record(entry);
			const container = value ? text(value.container) : undefined;
			if (!value || !container) return [];
			return [
				{
					container,
					provider: text(value.provider) ?? "docker",
					...(text(value.repository)
						? { repository: text(value.repository) }
						: {}),
					...(text(value.app) ? { app: text(value.app) } : {}),
					...(text(value.service) ? { service: text(value.service) } : {}),
					...(number(value.cpuPercent) !== undefined
						? { cpuPercent: number(value.cpuPercent) }
						: {}),
					...(number(value.memoryUsageBytes) !== undefined
						? { memoryUsageBytes: number(value.memoryUsageBytes) }
						: {}),
					...(number(value.memoryLimitBytes) !== undefined
						? { memoryLimitBytes: number(value.memoryLimitBytes) }
						: {}),
					...(number(value.memoryPercent) !== undefined
						? { memoryPercent: number(value.memoryPercent) }
						: {}),
					...(number(value.networkRxBytes) !== undefined
						? { networkRxBytes: number(value.networkRxBytes) }
						: {}),
					...(number(value.networkTxBytes) !== undefined
						? { networkTxBytes: number(value.networkTxBytes) }
						: {}),
					...(number(value.pids) !== undefined
						? { pids: number(value.pids) }
						: {}),
					...(text(value.readAt) ? { readAt: text(value.readAt) } : {}),
				},
			];
		}),
		unavailable: number(raw.unavailable) ?? 0,
		note: text(raw.note) ?? "",
	};
}

export function parseKubernetesClusters(
	raw: Record<string, unknown>,
): KubernetesClusterInfo[] {
	return values(raw.clusters).flatMap((entry) => {
		const value = record(entry);
		const id = value ? text(value.id) : undefined;
		const context = value ? text(value.context) : undefined;
		if (!value || !id || !context) return [];
		return [
			{
				id,
				context,
				repositories: values(value.repositories).flatMap((repository) =>
					typeof repository === "string" ? [repository] : [],
				),
			},
		];
	});
}

export function parseKubernetesResources(
	raw: Record<string, unknown>,
): KubernetesResources {
	return {
		cluster: text(raw.cluster) ?? "",
		namespace: text(raw.namespace) ?? "",
		output: text(raw.output) ?? "",
		truncated: raw.truncated === true,
		items: values(raw.items).flatMap((entry) => {
			const value = record(entry);
			const kind = value ? text(value.kind) : undefined;
			const name = value ? text(value.name) : undefined;
			if (!value || !kind || !name) return [];
			return [
				{
					kind,
					name,
					status: text(value.status) ?? "Unknown",
					...(text(value.ready) ? { ready: text(value.ready) } : {}),
					...(number(value.restarts) !== undefined
						? { restarts: number(value.restarts) }
						: {}),
					...(values(value.containers).some(
						(container) => typeof container === "string",
					)
						? {
								containers: values(value.containers).flatMap((container) =>
									typeof container === "string" ? [container] : [],
								),
							}
						: {}),
					...(text(value.age) ? { age: text(value.age) } : {}),
					...(text(value.createdAt)
						? { createdAt: text(value.createdAt) }
						: {}),
				},
			];
		}),
	};
}

export function parseKubernetesNamespaces(
	raw: Record<string, unknown>,
): KubernetesNamespaces {
	return {
		cluster: text(raw.cluster) ?? "",
		namespaces: values(raw.namespaces).flatMap((entry) =>
			typeof entry === "string" ? [entry] : [],
		),
	};
}

export function parseKubernetesEvents(
	raw: Record<string, unknown>,
): KubernetesEvents {
	return {
		cluster: text(raw.cluster) ?? "",
		namespace: text(raw.namespace) ?? "",
		output: text(raw.output) ?? "",
		truncated: raw.truncated === true,
		events: values(raw.events).flatMap((entry) => {
			const value = record(entry);
			const reason = value ? text(value.reason) : undefined;
			if (!value || !reason) return [];
			return [
				{
					type: text(value.type) ?? "Normal",
					reason,
					object: text(value.object) ?? "unknown",
					message: text(value.message) ?? "",
					...(number(value.count) !== undefined
						? { count: number(value.count) }
						: {}),
					...(text(value.lastTimestamp)
						? { lastTimestamp: text(value.lastTimestamp) }
						: {}),
				},
			];
		}),
	};
}

export function parseKubernetesDescribe(
	raw: Record<string, unknown>,
): KubernetesDescribe {
	return {
		cluster: text(raw.cluster) ?? "",
		namespace: text(raw.namespace) ?? "",
		kind: text(raw.kind) ?? "",
		name: text(raw.name) ?? "",
		output: text(raw.output) ?? "",
		truncated: raw.truncated === true,
	};
}

export function parseKubernetesPodLogs(
	raw: Record<string, unknown>,
): KubernetesPodLogs {
	return {
		cluster: text(raw.cluster) ?? "",
		namespace: text(raw.namespace) ?? "",
		pod: text(raw.pod) ?? "",
		...(text(raw.container) ? { container: text(raw.container) } : {}),
		...(raw.previous === true ? { previous: true } : {}),
		output: text(raw.output) ?? "",
		truncated: raw.truncated === true,
	};
}

function parseProviderWriteReceipt(
	raw: unknown,
): ProviderWriteReceipt | undefined {
	const value = record(raw);
	const requestId = value ? text(value.requestId) : undefined;
	const provider = value ? text(value.provider) : undefined;
	const action = value ? text(value.action) : undefined;
	const target = value ? text(value.target) : undefined;
	const digest = value ? text(value.digest) : undefined;
	const state = value ? text(value.state) : undefined;
	if (
		!value ||
		!requestId ||
		!provider ||
		!action ||
		!target ||
		!digest ||
		!state
	)
		return undefined;
	return {
		requestId,
		provider,
		action: action as ProviderWriteAction,
		target,
		digest,
		state: state as ProviderWriteReceipt["state"],
		createdAt: number(value.createdAt) ?? 0,
		updatedAt: number(value.updatedAt) ?? 0,
		...(record(value.result) ? { result: record(value.result) } : {}),
		...(text(value.error) ? { error: text(value.error) } : {}),
	};
}

export function parseProviderWriteOutcome(
	raw: Record<string, unknown>,
): ProviderWriteOutcome | undefined {
	const status = text(raw.status);
	const digest = text(raw.digest);
	if (!status || !digest) return undefined;
	if (status === "confirmation-required") {
		const intent = record(raw.intent);
		const provider = intent ? text(intent.provider) : undefined;
		const action = intent ? text(intent.action) : undefined;
		const target = intent ? text(intent.target) : undefined;
		if (!provider || !action || !target) return undefined;
		return {
			status,
			digest,
			intent: {
				provider,
				action: action as ProviderWriteAction,
				target,
			},
		};
	}
	if (status !== "completed" && status !== "replayed") return undefined;
	const receipt = parseProviderWriteReceipt(raw.receipt);
	if (!receipt) return undefined;
	return { status, digest, receipt };
}

export function parseProviderWrites(
	raw: Record<string, unknown>,
): ProviderWriteReceipt[] {
	return values(raw.writes).flatMap((entry) => {
		const receipt = parseProviderWriteReceipt(entry);
		return receipt ? [receipt] : [];
	});
}

export function parseGitRemotes(raw: Record<string, unknown>): GitRemotes {
	return {
		repository: text(raw.repository) ?? "",
		remotes: values(raw.remotes).flatMap((entry) => {
			const value = record(entry);
			const name = value ? text(value.name) : undefined;
			const fetchUrl = value ? text(value.fetchUrl) : undefined;
			if (!value || !name || !fetchUrl) return [];
			return [
				{
					name,
					fetchUrl,
					...(text(value.pushUrl) ? { pushUrl: text(value.pushUrl) } : {}),
				},
			];
		}),
		...(text(raw.note) ? { note: text(raw.note) } : {}),
	};
}

export function parseGitLog(raw: Record<string, unknown>): GitLog {
	return {
		repository: text(raw.repository) ?? "",
		...(text(raw.note) ? { note: text(raw.note) } : {}),
		commits: values(raw.commits).flatMap((entry) => {
			const value = record(entry);
			const sha = value ? text(value.sha) : undefined;
			const shortSha = value ? text(value.shortSha) : undefined;
			if (!value || !sha || !shortSha) return [];
			return [
				{
					sha,
					shortSha,
					subject: text(value.subject) ?? "",
					author: text(value.author) ?? "",
					...(text(value.date) ? { date: text(value.date) } : {}),
					...(values(value.refs).some((ref) => typeof ref === "string")
						? {
								refs: values(value.refs).flatMap((ref) =>
									typeof ref === "string" ? [ref] : [],
								),
							}
						: {}),
				},
			];
		}),
	};
}

export function parseGitCommitDetail(
	raw: Record<string, unknown>,
): GitCommitDetail {
	const sha = text(raw.sha) ?? "";
	return {
		sha,
		shortSha: text(raw.shortSha) ?? sha.slice(0, 8),
		subject: text(raw.subject) ?? "",
		author: text(raw.author) ?? "",
		...(text(raw.email) ? { email: text(raw.email) } : {}),
		...(text(raw.date) ? { date: text(raw.date) } : {}),
		parents: values(raw.parents).flatMap((parent) =>
			typeof parent === "string" ? [parent] : [],
		),
		body: text(raw.body) ?? "",
		files: values(raw.files).flatMap((entry) => {
			const value = record(entry);
			const path = value ? text(value.path) : undefined;
			if (!value || !path) return [];
			return [
				{
					path,
					...(number(value.additions) !== undefined
						? { additions: number(value.additions) }
						: {}),
					...(number(value.deletions) !== undefined
						? { deletions: number(value.deletions) }
						: {}),
					...(value.binary === true ? { binary: true } : {}),
				},
			];
		}),
		diff: text(raw.diff) ?? "",
		truncated: raw.truncated === true,
		...(text(raw.note) ? { note: text(raw.note) } : {}),
	};
}

export function parseGitTags(raw: Record<string, unknown>): GitTags {
	return {
		repository: text(raw.repository) ?? "",
		...(text(raw.note) ? { note: text(raw.note) } : {}),
		tags: values(raw.tags).flatMap((entry) => {
			const value = record(entry);
			const name = value ? text(value.name) : undefined;
			const sha = value ? text(value.sha) : undefined;
			if (!value || !name || !sha) return [];
			return [
				{
					name,
					sha,
					annotated: value.annotated === true,
					...(text(value.date) ? { date: text(value.date) } : {}),
					...(text(value.subject) ? { subject: text(value.subject) } : {}),
				},
			];
		}),
	};
}

export function parseGitStashes(raw: Record<string, unknown>): GitStashes {
	return {
		repository: text(raw.repository) ?? "",
		...(text(raw.note) ? { note: text(raw.note) } : {}),
		stashes: values(raw.stashes).flatMap((entry) => {
			const value = record(entry);
			const index = value ? number(value.index) : undefined;
			const ref = value ? text(value.ref) : undefined;
			if (!value || index === undefined || !ref) return [];
			return [
				{
					index,
					ref,
					...(text(value.branch) ? { branch: text(value.branch) } : {}),
					message: text(value.message) ?? "",
					...(text(value.date) ? { date: text(value.date) } : {}),
				},
			];
		}),
	};
}

export function parseGitWriteOutcome(
	raw: Record<string, unknown>,
): GitWriteOutcome | undefined {
	const status = text(raw.status);
	const digest = text(raw.digest);
	if (!status || !digest) return undefined;
	if (status === "confirmation-required") {
		const intent = record(raw.intent);
		const repository = intent ? text(intent.repository) : undefined;
		const action = intent ? text(intent.action) : undefined;
		const target = intent ? text(intent.target) : undefined;
		if (!repository || !action || !target) return undefined;
		return {
			status,
			digest,
			intent: { repository, action, target },
		};
	}
	if (status !== "completed" && status !== "replayed") return undefined;
	const outcome = record(raw.outcome);
	if (!outcome) return undefined;
	return { status, digest, outcome: parseGitAction(outcome) };
}

export function parseGitAction(raw: Record<string, unknown>): GitActionOutcome {
	const status =
		raw.status === "completed" || raw.status === "refused"
			? raw.status
			: "failed";
	return {
		repository: text(raw.repository) ?? "",
		action: text(raw.action) ?? "unknown",
		status,
		output: typeof raw.output === "string" ? raw.output : "",
		truncated: boolean(raw.truncated) ?? false,
		...(text(raw.reason) ? { reason: text(raw.reason) } : {}),
		...(text(raw.branch) ? { branch: text(raw.branch) } : {}),
		...(text(raw.path) ? { path: text(raw.path) } : {}),
		...(text(raw.head) ? { head: text(raw.head) } : {}),
	};
}

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
	const side =
		raw.side === "staged" || raw.side === "worktree" ? raw.side : "all";
	return {
		repository: text(raw.repository) ?? "",
		path: text(raw.path) ?? "",
		side,
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
		...(text(value.worktree) ? { worktree: text(value.worktree) } : {}),
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
		...(text(value.worktree) ? { worktree: text(value.worktree) } : {}),
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

export function filterBranches(
	branches: readonly GitBranch[],
	query: string,
): readonly GitBranch[] {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.filter((term) => term.length > 0);
	if (!terms.length) return branches;
	return branches.filter((branch) => {
		const haystack = `${branch.name} ${branch.upstream ?? ""}`.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
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
