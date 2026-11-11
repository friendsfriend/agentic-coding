// Canonical issue shapes shared by the provider ports
// (`port-git-providers-and-ai-to-bun`, task 3.1). Field names and JSON tags
// match `server/pkg/issues`, so the devenv issue clients parse the Bun response
// unchanged.
export interface IssueAuthor {
	name: string;
	username: string;
}

export interface Issue {
	id: number;
	iid: number;
	title: string;
	description: string;
	state: string;
	web_url: string;
	author: IssueAuthor;
	labels: string[];
	assignees: IssueAuthor[];
	milestone?: { title: string };
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
	author: IssueAuthor;
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

export interface IssueListOptions {
	scope?: string;
	state?: string;
	search?: string;
	labels?: string[];
	sortBy?: string;
	sortDirection?: string;
	page?: number;
	perPage?: number;
}

export interface IssueRepoInfo {
	readonly owner: string;
	readonly repo: string;
}

export interface IssueClient {
	getIssues(
		info: IssueRepoInfo | undefined,
		options: IssueListOptions,
	): Promise<IssueListResult>;
	getIssue(info: IssueRepoInfo | undefined, number: number): Promise<Issue>;
	getIssueComments(
		info: IssueRepoInfo | undefined,
		number: number,
	): Promise<IssueCommentListResult>;
	closeIssue(
		info: IssueRepoInfo | undefined,
		number: number,
		reason: string,
	): Promise<Issue>;
	reopenIssue(info: IssueRepoInfo | undefined, number: number): Promise<Issue>;
	setLabels(
		info: IssueRepoInfo | undefined,
		number: number,
		labels: string[],
	): Promise<Issue>;
	addAssignee(
		info: IssueRepoInfo | undefined,
		number: number,
		assignee: string,
	): Promise<Issue>;
	removeAssignee(
		info: IssueRepoInfo | undefined,
		number: number,
	): Promise<Issue>;
	addComment(
		info: IssueRepoInfo | undefined,
		number: number,
		body: string,
	): Promise<IssueComment>;
	getRepoLabels(info: IssueRepoInfo | undefined): Promise<string[]>;
	getRepoCollaborators(info: IssueRepoInfo | undefined): Promise<string[]>;
	getIssueLinkedChangeRequests(
		info: IssueRepoInfo | undefined,
		number: number,
	): Promise<ChangeRequestLike[]>;
	getIssueReferencedIssues(
		info: IssueRepoInfo | undefined,
		number: number,
	): Promise<Issue[]>;
	getChangeRequestLinkedIssues(
		info: IssueRepoInfo,
		number: number,
	): Promise<Issue[]>;
}

/** The subset of the change-request shape the issue routes return. */
export interface ChangeRequestLike {
	id: number;
	iid: number;
	title: string;
	description: string;
	source_branch: string;
	target_branch: string;
	default_branch?: string;
	state: string;
	web_url: string;
	created_at: string;
	updated_at: string;
	author: IssueAuthor;
	head_pipeline?: { id: number; status: string; web_url: string };
	merge_status: string;
	detailed_merge_status: string;
	draft: boolean;
	work_in_progress: boolean;
	has_conflicts: boolean;
	blocking_discussions_resolved: boolean;
	rebase_in_progress: boolean;
	merge_error: string;
	approvals?: Approvals;
}

export interface Approvals {
	approvals_required: number;
	approvals_left: number;
	approved_by: { user: IssueAuthor }[];
}

export function authorOf(username: string): IssueAuthor {
	return { name: username, username };
}

/** The comment shape the issue routes return for a canonical issue. */
export interface RawIssuePayload {
	id: number;
	number: number;
	title: string;
	body: string;
	state: string;
	html_url: string;
	user?: { login: string };
	labels?: { name: string }[];
	assignees?: { login: string }[];
	milestone?: { title: string } | null;
	created_at: string;
	updated_at: string;
}

export function issueFromRaw(raw: RawIssuePayload): Issue {
	const issue: Issue = {
		id: raw.id,
		iid: raw.number,
		title: raw.title,
		description: raw.body,
		state: raw.state,
		web_url: raw.html_url,
		author: authorOf(raw.user?.login ?? ""),
		labels: (raw.labels ?? []).map((label) => label.name),
		assignees: (raw.assignees ?? []).map((assignee) =>
			authorOf(assignee.login),
		),
		created_at: raw.created_at,
		updated_at: raw.updated_at,
	};
	if (raw.milestone) issue.milestone = { title: raw.milestone.title };
	return issue;
}
