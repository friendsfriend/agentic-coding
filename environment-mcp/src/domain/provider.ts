export type ProviderType = "github" | "gitlab";

export type ProviderConfig = {
	name: string;
	type: ProviderType;
	baseUrl: string;
	username: string;
	tokenRef: string;
};

export type ProviderProjection = {
	name: string;
	type: ProviderType;
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
	note?: "overflow";
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
	/** Provider thread identifier used to reply or resolve. For GitLab this is
	 * the discussion id; for GitHub it is the review-comment id. */
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

export type ProviderWriteIntent =
	| {
			action: "comment-change";
			provider: string;
			repository: string;
			number: number;
			body: string;
			requestId: string;
			confirm?: string;
	  }
	| {
			action: "comment-issue";
			provider: string;
			repository: string;
			number: number;
			body: string;
			requestId: string;
			confirm?: string;
	  }
	| {
			action: "approve-change";
			provider: string;
			repository: string;
			number: number;
			sha: string;
			requestId: string;
			confirm?: string;
	  }
	| {
			action: "merge-change";
			provider: string;
			repository: string;
			number: number;
			sha: string;
			mergeMethod: "merge" | "squash" | "rebase";
			requestId: string;
			confirm?: string;
	  }
	| {
			action: "set-issue-state";
			provider: string;
			repository: string;
			number: number;
			state: "open" | "closed";
			requestId: string;
			confirm?: string;
	  }
	| {
			action: "rebase-change";
			provider: string;
			repository: string;
			number: number;
			requestId: string;
			confirm?: string;
	  }
	| {
			action: "unapprove-change";
			provider: string;
			repository: string;
			number: number;
			sha: string;
			requestId: string;
			confirm?: string;
	  }
	| {
			action: "reply-discussion";
			provider: string;
			repository: string;
			number: number;
			scope: "change" | "issue";
			discussionId: string;
			body: string;
			requestId: string;
			confirm?: string;
	  }
	| {
			action: "set-discussion-resolved";
			provider: string;
			repository: string;
			number: number;
			discussionId: string;
			resolved: boolean;
			requestId: string;
			confirm?: string;
	  }
	| {
			action: "add-labels";
			provider: string;
			repository: string;
			number: number;
			scope: "change" | "issue";
			labels: readonly string[];
			requestId: string;
			confirm?: string;
	  }
	| {
			action: "set-assignees";
			provider: string;
			repository: string;
			number: number;
			scope: "change" | "issue";
			assignees: readonly string[];
			requestId: string;
			confirm?: string;
	  }
	| {
			action: "retry-job";
			provider: string;
			repository: string;
			job: number;
			requestId: string;
			confirm?: string;
	  }
	| {
			action: "retry-pipeline";
			provider: string;
			repository: string;
			pipeline: number;
			requestId: string;
			confirm?: string;
	  }
	| {
			action: "cancel-pipeline";
			provider: string;
			repository: string;
			pipeline: number;
			requestId: string;
			confirm?: string;
	  };

export type ProviderWriteReceipt = {
	requestId: string;
	provider: string;
	action: ProviderWriteAction;
	target: string;
	digest: string;
	state: "attempting" | "completed" | "failed";
	createdAt: number;
	updatedAt: number;
	result?: Record<string, unknown>;
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
			status: "completed";
			digest: string;
			receipt: ProviderWriteReceipt;
	  }
	| {
			status: "replayed";
			digest: string;
			receipt: ProviderWriteReceipt;
	  };

export type ProviderChangeState = "open" | "closed" | "all";

export interface ProviderPort {
	list(): readonly ProviderProjection[];
	repositories(
		provider: string,
		query: string,
		signal: AbortSignal,
	): Promise<readonly ProviderRepository[]>;
	changes(
		provider: string,
		repository: string,
		state: ProviderChangeState,
		signal: AbortSignal,
	): Promise<readonly ProviderChange[]>;
	issues(
		provider: string,
		repository: string,
		state: ProviderChangeState,
		signal: AbortSignal,
	): Promise<readonly ProviderIssue[]>;
	pipelines(
		provider: string,
		repository: string,
		signal: AbortSignal,
	): Promise<readonly ProviderPipeline[]>;
	jobs(
		provider: string,
		repository: string,
		pipeline: number,
		signal: AbortSignal,
	): Promise<readonly ProviderJob[]>;
	change(
		provider: string,
		repository: string,
		number: number,
		signal: AbortSignal,
	): Promise<ProviderChangeDetail>;
	changeFiles(
		provider: string,
		repository: string,
		number: number,
		signal: AbortSignal,
	): Promise<ProviderFiles>;
	changeVersions(
		provider: string,
		repository: string,
		number: number,
		signal: AbortSignal,
	): Promise<readonly ProviderVersion[]>;
	issue(
		provider: string,
		repository: string,
		number: number,
		signal: AbortSignal,
	): Promise<ProviderIssueDetail>;
	discussions(
		provider: string,
		repository: string,
		number: number,
		signal: AbortSignal,
	): Promise<readonly ProviderDiscussion[]>;
	issueComments(
		provider: string,
		repository: string,
		number: number,
		signal: AbortSignal,
	): Promise<readonly ProviderDiscussion[]>;
	jobLogs(
		provider: string,
		repository: string,
		job: number,
		signal: AbortSignal,
	): Promise<ProviderJobLogs>;
	write(
		intent: ProviderWriteIntent,
		signal: AbortSignal,
	): Promise<ProviderWriteOutcome>;
	writes(provider?: string): readonly ProviderWriteReceipt[];
}
