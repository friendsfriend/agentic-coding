// Type definitions for DevEnv TUI

export * from "./action-definition";
export * from "./action-labels";
export * from "./action-run";

// Provider types
export type ProviderType = "github" | "gitlab";

export interface Provider {
	name: string;
	type: ProviderType | "";
	username: string;
	has_token: boolean;
	missing_vars?: string[];
	invalid?: boolean;
	reason?: string;
	message?: string;
}

export interface ProviderCreateRequest {
	name: string;
	type: ProviderType;
	username: string;
	token: string;
}

export interface ProviderUpdateRequest {
	username?: string;
	token?: string;
}

export interface AppRunTargetInfo {
	runtime: ActionRuntime | string;
	launchMode?: LaunchMode | string;
	label?: string;
	profile?: string;
	targetId?: string;
	sourcePath?: string;
	startedAt: string;
	display: string;
}

export type RuntimeState =
	| "running"
	| "starting"
	| "failed"
	| "stopped"
	| "unknown";

export interface RuntimeStatus {
	state: RuntimeState;
	detail?: string;
}

export type ResourceKind = "app" | "library" | "infrastructure";

export interface App {
	ident: string;
	resourceId?: string;
	resourceKind?: ResourceKind;
	displayName: string;
	localDirectoryPath: string;
	repositoryPath: string;
	branch: string;
	appType: "APP" | "LIB";
	containerBaseName: string;
	sourceType?: ProviderType;
	provider?: string;
	activeWorktree?: string;
	mainWorktreeBranch?: string;
	dockerInfo?: DockerInfo;
	gitStatus?: string;
	operationStatus?: OperationStatus;
	runTargetInfo?: AppRunTargetInfo;
	runtimeStatus?: RuntimeStatus;
	status?: "running" | "stopped" | "failed" | string;
	// Transitional table fields. App rows do not populate these, but keeping them
	// optional allows generic table/action helpers to inspect TableRow safely.
	type?: InfraServiceType;
	logPath?: string;
	shellPath?: string;
	powerShellPath?: string;
	defaultRunner?: ScriptRunner;
	resourceType?: "script-folder" | "script-file";
	scriptPath?: string;
	scriptRelativePath?: string;
	scriptDepth?: number;
	scriptExpanded?: boolean;
	scriptExecutable?: boolean;
	interpreter?: string | null;
	scriptParameters?: ScriptParameter[];
}

export interface AppTableRow extends App {
	rowKind: "app";
}

export interface InfraTableRow extends InfraService {
	rowKind: "infra";
	// Non-infra row fields stay optional so generic table helpers can inspect rows safely.
	localDirectoryPath?: string;
	repositoryPath?: string;
	branch?: string;
	appType?: never;
	sourceType?: never;
	provider?: never;
	resourceType?: never;
	scriptPath?: never;
	scriptRelativePath?: never;
	scriptDepth?: never;
	scriptExpanded?: never;
	scriptExecutable?: never;
	interpreter?: never;
	scriptParameters?: never;
}

export interface TaskTableRow {
	rowKind: "script";
	ident: string;
	displayName: string;
	localDirectoryPath?: string;
	repositoryPath?: string;
	branch?: string;
	appType?: never;
	sourceType?: never;
	provider?: never;
	containerBaseName?: never;
	nodeType: "folder" | "script";
	resourceType: "script-folder" | "script-file";
	scriptPath: string;
	scriptRelativePath: string;
	scriptDepth: number;
	scriptExpanded?: boolean;
	scriptExecutable: boolean;
	interpreter?: string | null;
	scriptParameters?: ScriptParameter[];
	status?: string;
	runtimeStatus?: RuntimeStatus;
	dockerInfo?: DockerInfo;
	operationStatus?: OperationStatus;
}

export type TableRow = AppTableRow | InfraTableRow | TaskTableRow;

export type AppAction = "build" | "test" | "run";
export type ActionRuntime =
	| "docker"
	| "shell"
	| "powershell"
	| "systemshell"
	| "kubernetes";
export type LaunchMode = "logged" | "tmux";

export interface DependencyRef {
	app?: string;
	runtime?: ActionRuntime;
	profile?: string;
	infra?: string;
}

export type KubernetesClusterState =
	| "missing"
	| "running"
	| "degraded"
	| "unreachable";

export interface KubernetesClusterStatus {
	clusterName: string;
	contextName: string;
	provider: string;
	exists: boolean;
	reachable: boolean;
	state: KubernetesClusterState;
	kubernetesVersion?: string;
	nodes: KubernetesClusterNodeSummary[];
	namespaces: KubernetesNamespaceSummary[];
	pods: KubernetesPodSummary;
	podList?: KubernetesPodListItem[];
	releases: KubernetesDevEnvReleaseSummary[];
	stats?: KubernetesClusterResourceStats;
	warnings?: string[];
	collectedAt: string;
}

export interface KubernetesClusterNodeSummary {
	name: string;
	ready: boolean;
	role?: string;
	kubeletVersion?: string;
}

export interface KubernetesNamespaceSummary {
	name: string;
	pods: number;
}

export interface KubernetesPodSummary {
	total: number;
	running: number;
	pending: number;
	succeeded: number;
	failed: number;
	unknown: number;
}

export interface KubernetesPodListItem {
	name: string;
	namespace: string;
	status: string;
}

export interface KubernetesDevEnvReleaseSummary {
	name: string;
	namespace: string;
	status: string;
	chart?: string;
	revision?: string;
}

export interface KubernetesClusterResourceStats {
	cpuPercent: number;
	memoryUsageBytes: number;
	memoryLimitBytes: number;
	memoryPercent: number;
	nodes: KubernetesNodeResourceStats[];
	collectedAt: string;
}

export interface KubernetesNodeResourceStats {
	name: string;
	containerName: string;
	cpuPercent: number;
	memoryUsageBytes: number;
	memoryLimitBytes: number;
	memoryPercent: number;
}

export interface KubernetesTargetMetadata {
	chartPath: string;
	release: string;
	namespace: string;
	valuesFiles?: string[];
	image?: {
		repository?: string;
		tag?: string;
		pullPolicy?: string;
	};
	secrets?: { name: string; keys: string[] }[];
	ports?: {
		name?: string;
		resource: string;
		localPort: number;
		remotePort: number;
	}[];
	sourcePath: string;
}

export interface ActionTarget {
	id: string;
	action: AppAction;
	runtime: ActionRuntime;
	label: string;
	profile?: string;
	launchMode?: LaunchMode;
	sourcePath: string;
	requires?: DependencyRef[];
	kubernetes?: KubernetesTargetMetadata;
}

export interface ActionTargetsResponse {
	targets: ActionTarget[];
}

export interface ShellActionScriptRequest {
	ident: string;
	action: AppAction;
	profile?: string;
	command?: string;
	runtime?: ActionRuntime;
}

export interface ShellActionScriptResponse {
	success: boolean;
	path: string;
}

export interface AppStatus {
	ident: string;
	resourceId?: string;
	resourceKind?: ResourceKind;
	dockerInfo?: DockerInfo;
	gitStatus?: string;
	branch?: string;
	activeWorktree?: string;
	operationStatus?: OperationStatus;
	runTargetInfo?: AppRunTargetInfo | null;
	runtimeStatus?: RuntimeStatus | null;
	status?: "running" | "stopped" | "failed" | string;
	missingEnvVars?: string[];
}

// Operation status for showing in-progress operations
export interface OperationStatus {
	operation: OperationType; // What operation is running
	status: StatusType; // Current status
	message: string; // Display message
}

export type OperationType =
	| "pull"
	| "push"
	| "fetch"
	| "checkout"
	| "build"
	| "test"
	| "run"
	| "start"
	| "stop"
	| "script";

export type StatusType = "pending" | "active" | "completed" | "failed";

export interface DockerInfo {
	Status: string; // Go uses PascalCase
	ContainerID: string; // Go uses PascalCase
	Ports: string; // Go uses PascalCase
}

export type InfraServiceType = "docker" | "script" | "kubernetes";
export type InfraServiceStatus = "running" | "stopped" | "failed" | string;
export type ScriptRunner = "shell" | "powershell";

export interface ExecutionHandle {
	mode: string;
	paneId?: string;
	pid?: number;
	runner?: ScriptRunner | string;
	startedAt?: string;
	exitCode?: number;
}

export interface InfraService {
	ident: string;
	resourceId?: string;
	resourceKind?: ResourceKind;
	displayName: string;
	type?: InfraServiceType;
	containerBaseName?: string;
	dockerInfo?: DockerInfo;
	runtimeStatus?: RuntimeStatus;
	status?: InfraServiceStatus;
	logPath?: string;
	shellPath?: string;
	powerShellPath?: string;
	defaultRunner?: ScriptRunner;
	operationStatus?: OperationStatus;
	executionHandle?: ExecutionHandle;
}

export type ScriptParameterType =
	| "string"
	| "int"
	| "decimal"
	| "number"
	| "bool"
	| "enum";

export interface ScriptParameter {
	name: string;
	type: ScriptParameterType;
	required: boolean;
	description?: string;
	defaultValue?: string;
	choices?: string[];
	flag?: string;
}

export interface ScriptNode {
	name: string;
	relativePath: string;
	absolutePath: string;
	nodeType: "folder" | "script";
	interpreter?: string;
	parameters?: ScriptParameter[];
	children?: ScriptNode[];
}

export interface ScriptListResponse {
	scripts: ScriptNode[];
}

export interface ScriptMetadataResponse {
	parameters: ScriptParameter[];
}

export interface ExecuteScriptRequest {
	relativePath: string;
	args?: string[];
}

export interface ExecuteScriptResponse {
	success: boolean;
	relativePath: string;
	interpreter: string;
	output?: string;
}

export interface CreateScriptRequest {
	targetPath: string;
}

export interface LinkScriptRequest {
	targetPath: string;
	sourcePath: string;
}

export interface DeleteScriptRequest {
	relativePath: string;
}

export interface ScriptMutationResponse {
	success: boolean;
	operation: "create" | "link" | "delete";
	relativePath: string;
	absolutePath: string;
}

export interface ScriptArgsHistoryResponse {
	relativePath: string;
	entries: Record<string, string>[];
}

export interface ScriptArgsHistoryRequest {
	relativePath: string;
	values: Record<string, string>;
}

export interface ScriptVisibleRow {
	name: string;
	relativePath: string;
	absolutePath: string;
	nodeType: "folder" | "script";
	interpreter?: string;
	parameters?: ScriptParameter[];
	depth: number;
}

export interface GitInfo {
	branch: string;
	status: string;
}

export interface ServerEvent {
	type: string;
	properties: Record<string, unknown>;
	timestamp: string;
}

// GitLab Change Request types

// ChangeRequestListResult represents a paginated response from the change request list endpoint.
export interface ChangeRequestListResult {
	items: ChangeRequest[];
	totalCount: number;
	totalPages: number;
	currentPage: number;
	perPage: number;
}

export interface ChangeRequest {
	id: number;
	iid: number;
	title: string;
	description: string;
	source_branch: string;
	target_branch: string;
	default_branch?: string;
	state: string; // opened, merged, closed
	web_url: string;
	created_at: string;
	updated_at: string;
	author: {
		name: string;
		username: string;
	};
	head_pipeline?: {
		id: number;
		status: string;
		web_url: string;
		sha?: string;
	};
	merge_status: string;
	detailed_merge_status: string;
	draft: boolean;
	work_in_progress: boolean;
	has_conflicts: boolean;
	blocking_discussions_resolved: boolean;
	rebase_in_progress: boolean;
	merge_error?: string; // error message if merge/rebase failed
	approvals?: ChangeRequestApprovals;
}

export interface ChangeRequestApprovals {
	approvals_required: number;
	approvals_left: number;
	approved_by: Array<{
		user: {
			name: string;
			username: string;
		};
	}>;
}

export interface ChangeRequestChange {
	old_path: string;
	new_path: string;
	a_mode: string;
	b_mode: string;
	new_file: boolean;
	renamed_file: boolean;
	deleted_file: boolean;
	diff: string;
	lines_added: number;
	lines_deleted: number;
	diff_lines?: DiffLine[]; // Parsed diff lines with line codes
}

export interface DiffLine {
	line_code: string; // GitLab's unique identifier for this line
	type: string; // "new", "old", "match" (context)
	old_line?: number; // Line number in old file (undefined for added lines)
	new_line?: number; // Line number in new file (undefined for deleted lines)
	text: string; // The actual line content
	rich_text?: string; // HTML-formatted text (if available)
}

// Discussion/Comment types
export interface Discussion {
	id: string;
	individual_note: boolean; // true if single comment, false if thread
	notes: Note[];
	position?: NotePosition; // Position in diff (for diff comments)
}

export interface Note {
	id: number;
	type: string; // "DiffNote", "DiscussionNote", etc.
	body: string; // Comment text (markdown)
	author: NoteAuthor;
	created_at: string;
	updated_at: string;
	system: boolean; // true for system-generated notes
	position?: NotePosition; // Position in diff
	resolvable: boolean; // Can this note be resolved?
	resolved: boolean; // Is this note resolved?
	resolved_by?: NoteAuthor;
	resolved_at?: string;
}

export interface NoteAuthor {
	id: number;
	username: string;
	name: string;
	avatar_url: string;
}

export interface CRVersion {
	base_commit_sha: string;
	head_commit_sha: string;
	start_commit_sha: string;
}

export interface CRCommentPosition {
	baseSHA: string;
	headSHA: string;
	startSHA: string;
	positionType: string;
	newPath: string;
	oldPath: string;
	newLine?: number;
	oldLine?: number;
	lineCode?: string;
	lineRange?: {
		start: {
			type: string;
			oldLine?: number;
			newLine?: number;
		};
		end: {
			type: string;
			oldLine?: number;
			newLine?: number;
		};
	};
}

export interface CRCommentRequest {
	appIdent: string;
	crIID: number;
	body: string;
	position?: {
		base_sha: string;
		head_sha: string;
		start_sha: string;
		position_type: string;
		new_path: string;
		old_path: string;
		new_line?: number;
		old_line?: number;
		line_code?: string;
		line_range?: {
			start: {
				type: string;
				old_line?: number;
				new_line?: number;
			};
			end: {
				type: string;
				old_line?: number;
				new_line?: number;
			};
		};
	};
}

export interface CRMutationResult {
	status: string;
	message: string;
}

export interface NotePosition {
	base_sha: string;
	start_sha: string;
	head_sha: string;
	old_path: string;
	new_path: string;
	position_type: string; // "text", "image", or "file"
	old_line?: number;
	new_line?: number;
	line_range?: {
		start: {
			line_code: string;
			type: string;
			old_line?: number;
			new_line?: number;
		};
		end: {
			line_code: string;
			type: string;
			old_line?: number;
			new_line?: number;
		};
	}; // For multi-line comments
}

// GitLab Pipeline types
export interface Pipeline {
	id: number;
	iid: number;
	project_id: number;
	status: string; // success, failed, running, pending, canceled, skipped
	ref: string; // branch name
	sha: string;
	web_url: string;
	created_at: string;
	updated_at: string;
	user: {
		name: string;
		username: string;
	};
	source: string;
}

export interface Job {
	id: number;
	name: string;
	stage: string;
	status: string; // success, failed, running, pending, canceled, skipped, created, manual
	web_url: string;
	created_at?: string;
	started_at?: string;
	finished_at?: string;
	duration?: number; // in seconds
	queued_duration?: number; // in seconds
	runner?: {
		id: number;
		description: string;
		name: string;
	};
	pipeline: {
		id: number;
	};
}

// Test results types
export interface TestCase {
	name: string;
	classname: string;
	status: string; // success, failed, skipped, error
	execution_time: number;
	system_output?: string;
	stack_trace?: string;
}

export interface TestSuite {
	name: string;
	test_cases: TestCase[];
}

export interface FailedTestGroup {
	class_name: string;
	test_methods: string[];
}

export interface TestSummary {
	total: number;
	success: number;
	failed: number;
	skipped: number;
	error: number;
	test_suites?: TestSuite[];
	failed_test_groups?: FailedTestGroup[];
}

// Agent space types
export interface AgentSpace {
	id: string;
	name: string;
	description: string;
	repoDirs: string[];
	hasAgent: boolean;
}

export interface AgentSessionInfo {
	id: string;
	title: string;
	timeCreated: number; // Unix ms
	timeUpdated: number; // Unix ms
}

export interface AgentGroup {
	name: string; // e.g. "Sisyphus (Ultraworker)"
	model: string; // e.g. "claude-opus-4.6"
	sessions: AgentSessionInfo[];
}

export interface SshHost {
	alias: string; // Host alias from ~/.ssh/config (e.g. "prod-server")
	hostname?: string; // HostName directive value
	user?: string; // User directive value
	port?: number; // Port directive value (default 22)
	identityFile?: string; // IdentityFile directive value
}

export interface RepoSearchResult {
	name: string;
	fullPath: string;
	url: string;
	defaultBranch: string;
}

export interface RepoSearchRequest {
	provider: string;
	query: string;
	host?: string;
}

export interface CreateAppRequest {
	displayName: string;
	repositoryURL: string;
	branch: string;
	provider: string;
	definitionLocation: "apps" | "libraries";
}

export interface WorktreeInfo {
	branch: string;
	path: string;
	isMain: boolean;
	active: boolean;
}

// Issue types
export type IssueScope =
	| "all"
	| "assigned-to-me"
	| "created-by-me"
	| "no-assignee";

export interface Issue {
	id: number;
	iid: number;
	title: string;
	description: string;
	state: string;
	web_url: string;
	author: {
		name: string;
		username: string;
	};
	labels: string[];
	assignees: Array<{
		name: string;
		username: string;
	}>;
	milestone?: {
		title: string;
	};
	created_at: string;
	updated_at: string;
}

export interface IssueListResult {
	items: Issue[];
	totalCount: number;
	totalPages: number;
	currentPage: number;
	perPage: number;
}

export interface IssueComment {
	id: number;
	body: string;
	author: {
		name: string;
		username: string;
	};
	created_at: string;
	updated_at: string;
	system: boolean;
}

export interface IssueCommentListResult {
	items: IssueComment[];
	totalCount: number;
	totalPages: number;
	currentPage: number;
	perPage: number;
}

export interface ContainerStats {
	cpuPercent: number;
	memoryUsage: number;
	memoryLimit: number;
	memoryPercent: number;
	timestamp: string;
}
