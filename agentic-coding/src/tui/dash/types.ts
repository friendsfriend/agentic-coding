/** Shared dashboard data shapes. Owned here so observation, projection,
 * review, and root wiring modules can reference the same typed data
 * without importing each other.
 */
import type { DeveloperDialogueRecord } from "../../workflow/contracts.ts";

export interface WorkflowState {
	/** User-supplied workflow identifier; dashboards address workflows by it. */
	workflowId: string;
	/** Planner-recorded primary change id; empty until the plan step. */
	changeId: string;
	phase: string;
	stepId?: string;
	stepLabel?: string;
	revision: number;
	definition?: { id: string; version: number; digest: string; label: string };
	status: string;
	health: { valid: boolean; attention: string[]; diagnostic?: string };
	availableActions?: Array<{ id: string; label: string; confirmation: string }>;
	repository: string;
	worktree: string;
	branch: string;
	task?: string;
	workspace: string;
	verificationRound: number;
	baseCommit?: string;
	createdAt?: string;
	phaseStartedAt?: string;
	prCreated?: boolean;
	prUrl?: string | null;
	ticketNumber?: string;
	workerModel?: string;
	returnWorkspace?: string;
	verificationTier?: string;
	verificationRoles?: string[];
	runs: Array<{
		id: string;
		stepId: string;
		role: string;
		attempt: number;
		status: string;
		runtime: string;
		profile: string;
		model?: string;
		paneId?: string;
		outputPath?: string;
		outputDigest?: string;
	}>;
	verificationResults?: Record<string, unknown>;
	verificationReusedResults?: Record<string, unknown>;
	verificationStartedAt?: string;
	testVerifierStarted?: boolean;
	verificationTimeoutRoles?: string[];
	verificationRoleStartedAt?: Record<string, string>;
	verificationModels?: Record<string, string>;
	developerDialogue?: DeveloperDialogueRecord[];
	pendingQuestions?: DeveloperDialogueRecord[];
	planQuality?: {
		passed: boolean;
		issues: string[];
		specFiles: number;
		taskCount: number;
	};
	panes: Record<string, string>;
}

export interface WorktreeGitStatus {
	/** False when Git could not be inspected (missing or non-Git worktree). */
	available: boolean;
	/** Bounded reason shown when unavailable. */
	diagnostic?: string;
	branch?: string;
	changedFiles: number;
	addedFiles: number;
	deletedFiles: number;
	/** Undefined when the branch has no configured upstream. */
	ahead?: number;
	behind?: number;
	noUpstream: boolean;
}

export interface WorkflowOverview {
	state: WorkflowState;
	workspaceOpen: boolean;
	tasks: [number, number];
	// WorkflowOverview agents: role/status/model plus lifetime cost.
	agents: Array<{
		role: string;
		status: string;
		runtime?: string;
		model?: string;
		cost?: number;
	}>;
}

export interface LocalChange {
	oldPath?: string;
	newPath: string;
	linesAdded: number;
	linesDeleted: number;
	newFile: boolean;
	deletedFile: boolean;
	renamedFile: boolean;
}
export interface DeveloperReviewComment {
	filePath: string;
	line: number;
	startLine?: number;
	endLine?: number;
	body: string;
	findingId?: string;
}

export interface PlanReviewComment {
	filePath: string;
	line: number;
	startLine?: number;
	endLine?: number;
	body: string;
}
export type WikiReviewComment = PlanReviewComment;

export interface DeveloperReviewFinding {
	id: string;
	originalId: string;
	severity: "warning" | "info";
	path?: string;
	line?: number;
	detail: string;
	evidence?: string;
	fix?: string;
}

export interface FindingCounts {
	critical: number;
	warning: number;
	info: number;
}
export interface DashboardData {
	state: WorkflowState;
	request: string;
	proposal: string;
	review: string;
	reviewHistory: string[];
	agents: Array<{
		role: string;
		status: string;
		runtime?: string;
		model?: string;
		cost?: number;
		metrics?: AgentUsageMetrics;
		findingCounts?: FindingCounts;
	}>;
	updated: string;
	health: { dirty: boolean; ahead: number; behind: number; branch: string };
	gitStatus: WorktreeGitStatus;
	age: string;
	events: Array<{
		at: string;
		event: string;
		role?: string;
		model?: string;
		cost?: number;
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
		status?: number;
		tier?: string;
		roles?: string[];
		reports?: string[];
		fallback?: string;
	}>;
	verifierTimeline: Array<{
		role: string;
		status: string;
		rawStatus?: string;
		diagnostic?: string;
		durationSeconds?: number;
		model?: string;
		providerErrors: number;
		fallback: boolean;
	}>;
	costBreakdown: Array<Omit<CostRow, "messages"> & { messages: CostMessage[] }>;
}

export interface CostRow {
	role: string;
	messages: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cost: number;
}

export interface CostMessage {
	at: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cost: number;
}

export interface AgentUsageMetrics {
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	durationSeconds?: number;
	tokensPerSecond?: number;
}
export type RequiredUserActionItem =
	| { label: string; kind: "artifact"; value: string }
	| { label: string; kind: "workflow"; value: string }
	| { label: string; kind: "review"; value: string }
	| { label: string; kind: "dismiss" };

export interface RequiredUserAction {
	key: string;
	title: string;
	prompt: string;
	items: RequiredUserActionItem[];
}

/** One parsed finding from a committed verifier `core.findings` artifact. */
export interface VerifierFinding {
	id: string;
	severity: "critical" | "warning" | "info";
	detail: string;
	path?: string;
	line?: number;
	status?: string;
	evidence?: string;
	changedCode?: string;
	fix?: string;
}
