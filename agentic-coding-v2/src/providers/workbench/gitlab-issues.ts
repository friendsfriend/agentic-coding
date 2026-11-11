// GitLab issue capability (`port-git-providers-and-ai-to-bun`,
// tasks 3.5-3.6), ported from `server/pkg/gitlab/{issues_client,
// issue_linked_mrs,issue_referenced_issues,mr_linked_issues}.go`.
//
// Behavior reproduced as-is:
//   - Scope maps to GitLab's underscore values (`assigned_to_me`,
//     `created_by_me`) and `no-assignee` becomes `assignee_id=None`.
//   - `state=open` is normalized to `opened`; the state parameter is set twice
//     in the Go code and the normalized value wins.
//   - The comment list reports `totalCount: -1` and `totalPages: -1`.
//   - Linked change requests merge the `closed_by` endpoint, the issue-links
//     endpoint and inline `!123` references, deduplicated by IID.
//   - Referenced issues come from bare `#123` references only.

import {
	type GitLabClient,
	type GitLabProjectInfo,
	gitLabPagination,
	projectPath,
} from "./gitlab-client.ts";
import type {
	ChangeRequestLike,
	Issue,
	IssueClient,
	IssueComment,
	IssueCommentListResult,
	IssueListOptions,
	IssueListResult,
	IssueRepoInfo,
} from "./issues.ts";
import { goRfc3339 } from "./provider-time.ts";

interface RawIssue {
	id: number;
	iid: number;
	title: string;
	description: string;
	state: string;
	web_url: string;
	author?: { name: string; username: string };
	labels?: string[];
	assignees?: { name: string; username: string }[];
	milestone?: { title: string } | null;
	created_at: string;
	updated_at: string;
}

interface RawNote {
	id: number;
	body: string;
	author?: { name: string; username: string };
	created_at: string;
	updated_at: string;
	system: boolean;
}

interface RawClosedByMr {
	id: number;
	iid: number;
	title: string;
	description: string;
	state: string;
	web_url: string;
	created_at: string;
	updated_at: string;
	author?: { name: string; username: string };
	source_branch: string;
	target_branch: string;
	merge_status: string;
	draft: boolean;
	work_in_progress: boolean;
	has_conflicts: boolean;
	blocking_discussions_resolved: boolean;
	head_pipeline?: { id: number; status: string; web_url: string } | null;
}

/** `#123` references, deduplicated in order. */
export function parseReferencedIssueRefs(body: string): number[] {
	const seen = new Set<number>();
	const refs: number[] = [];
	for (const match of body.matchAll(/#(\d+)\b/g)) {
		const num = Number(match[1]);
		if (!Number.isInteger(num) || seen.has(num)) continue;
		seen.add(num);
		refs.push(num);
	}
	return refs;
}

/** `!123` merge-request references, deduplicated in order. */
export function parseInlineMrReferences(body: string): number[] {
	const seen = new Set<number>();
	const refs: number[] = [];
	for (const match of body.matchAll(/!(\d+)/g)) {
		const num = Number(match[1]);
		if (!Number.isInteger(num) || seen.has(num)) continue;
		seen.add(num);
		refs.push(num);
	}
	return refs;
}

/** GitLab issue search sort fields. */
function normalizeIssueSort(sortBy: string): string {
	switch (sortBy) {
		case "created":
		case "created_at":
			return "created_at";
		case "updated":
		case "updated_at":
			return "updated_at";
		case "title":
		case "priority":
		case "due_date":
		case "relative_position":
		case "label_priority":
		case "milestone_due":
		case "popularity":
			return sortBy;
		default:
			return "updated_at";
	}
}

function sortedParams(entries: Readonly<Record<string, string>>): string {
	const params = new URLSearchParams();
	for (const key of Object.keys(entries).sort()) params.set(key, entries[key]);
	return params.toString();
}

export class GitLabIssues implements IssueClient {
	private readonly client: GitLabClient;
	private readonly project: GitLabProjectInfo;

	constructor(client: GitLabClient, project: GitLabProjectInfo) {
		this.client = client;
		this.project = project;
	}

	private get base(): string {
		return `${this.client.baseUrl}/api/v4/projects/${projectPath(this.project)}`;
	}

	async getIssues(
		_info: IssueRepoInfo | undefined,
		options: IssueListOptions = {},
	): Promise<IssueListResult> {
		const page = options.page && options.page > 0 ? options.page : 1;
		const perPage =
			options.perPage && options.perPage > 0 ? options.perPage : 50;
		const scope = options.scope ?? "";
		const search = options.search ?? "";
		const state =
			options.state !== undefined && options.state !== ""
				? options.state
				: "opened";
		const sortBy =
			options.sortBy !== undefined && options.sortBy !== ""
				? normalizeIssueSort(options.sortBy)
				: "updated_at";
		const sortDirection =
			options.sortDirection === "asc" || options.sortDirection === "desc"
				? options.sortDirection
				: "desc";
		const labels = options.labels ?? [];

		const params: Record<string, string> = {
			state,
			page: String(page),
			per_page: String(perPage),
			order_by: sortBy,
			sort: sortDirection,
		};
		switch (scope) {
			case "all":
				params.scope = "all";
				break;
			case "assigned-to-me":
				params.scope = "assigned_to_me";
				break;
			case "created-by-me":
				params.scope = "created_by_me";
				break;
			case "no-assignee":
				params.assignee_id = "None";
				break;
		}
		if (labels.length > 0) params.labels = labels.join(",");
		if (search !== "") params.search = search;
		// The state parameter is written twice in the Go client; the normalized
		// value is the one that survives.
		params.state = state === "open" ? "opened" : state;

		const response = await this.client.request(
			`${this.base}/issues?${sortedParams(params)}`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitLab API error (status ${response.status}): ${response.body}`,
			);
		const pagination = gitLabPagination(response.headers, page);
		const issues = parseArray<RawIssue>(
			response.body,
			"failed to parse issues",
		);
		return {
			items: issues.map(convertIssue),
			totalCount: pagination.totalCount,
			totalPages: pagination.totalPages,
			currentPage: pagination.currentPage,
			perPage,
		};
	}

	async getIssue(
		_info: IssueRepoInfo | undefined,
		number: number,
	): Promise<Issue> {
		const response = await this.client.request(`${this.base}/issues/${number}`);
		if (response.status !== 200)
			throw new Error(
				`GitLab API error (status ${response.status}): ${response.body}`,
			);
		return convertIssue(
			parseObject<RawIssue>(response.body, "failed to parse issue"),
		);
	}

	async getIssueComments(
		_info: IssueRepoInfo | undefined,
		number: number,
	): Promise<IssueCommentListResult> {
		const response = await this.client.request(
			`${this.base}/issues/${number}/notes?per_page=100`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitLab API error (status ${response.status}): ${response.body}`,
			);
		const notes = parseArray<RawNote>(
			response.body,
			"failed to parse issue notes",
		);
		return {
			items: notes.map(convertNote),
			totalCount: -1,
			totalPages: -1,
			currentPage: 1,
			perPage: 100,
		};
	}

	// ---- Mutations ----

	async closeIssue(
		_info: IssueRepoInfo | undefined,
		number: number,
		_reason: string,
	): Promise<Issue> {
		return this.updateIssue(number, { state_event: "close" }, "closed issue");
	}

	async reopenIssue(
		_info: IssueRepoInfo | undefined,
		number: number,
	): Promise<Issue> {
		return this.updateIssue(
			number,
			{ state_event: "reopen" },
			"reopened issue",
		);
	}

	async setLabels(
		_info: IssueRepoInfo | undefined,
		number: number,
		labels: string[],
	): Promise<Issue> {
		return this.updateIssue(number, { labels }, "updated issue");
	}

	async addAssignee(
		_info: IssueRepoInfo | undefined,
		number: number,
		assignee: string,
	): Promise<Issue> {
		return this.updateIssue(
			number,
			{ assignee_ids: [assignee] },
			"updated issue",
		);
	}

	async removeAssignee(
		_info: IssueRepoInfo | undefined,
		number: number,
	): Promise<Issue> {
		return this.updateIssue(number, { assignee_ids: [] }, "updated issue");
	}

	private async updateIssue(
		number: number,
		payload: Record<string, unknown>,
		label: string,
	): Promise<Issue> {
		const response = await this.client.request(
			`${this.base}/issues/${number}`,
			{
				method: "PUT",
				body: JSON.stringify(payload),
				contentType: "application/json",
			},
		);
		if (response.status !== 200)
			throw new Error(
				`GitLab API error (status ${response.status}): ${response.body}`,
			);
		return convertIssue(
			parseObject<RawIssue>(response.body, `failed to parse ${label}`),
		);
	}

	async addComment(
		_info: IssueRepoInfo | undefined,
		number: number,
		body: string,
	): Promise<IssueComment> {
		const response = await this.client.request(
			`${this.base}/issues/${number}/notes`,
			{
				method: "POST",
				body: JSON.stringify({ body }),
				contentType: "application/json",
			},
		);
		if (response.status !== 201)
			throw new Error(
				`GitLab API error (status ${response.status}): ${response.body}`,
			);
		return convertNote(
			parseObject<RawNote>(response.body, "failed to parse created note"),
		);
	}

	async getRepoLabels(_info: IssueRepoInfo | undefined): Promise<string[]> {
		const response = await this.client.request(
			`${this.base}/labels?per_page=100`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitLab API error (status ${response.status}): ${response.body}`,
			);
		return parseArray<{ name: string }>(
			response.body,
			"failed to parse labels",
		).map((label) => label.name);
	}

	async getRepoCollaborators(
		_info: IssueRepoInfo | undefined,
	): Promise<string[]> {
		const response = await this.client.request(
			`${this.base}/members?per_page=100`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitLab API error (status ${response.status}): ${response.body}`,
			);
		return parseArray<{ username: string }>(
			response.body,
			"failed to parse members",
		).map((member) => member.username);
	}

	// ---- Linked and referenced items ----

	/** Change requests linked to an issue: `closed_by` first, then the
	 * issue-links endpoint, then inline `!123` references, deduplicated. */
	async getIssueLinkedChangeRequests(
		_info: IssueRepoInfo | undefined,
		number: number,
	): Promise<ChangeRequestLike[]> {
		const results: ChangeRequestLike[] = [];
		const seen = new Set<number>();

		try {
			for (const mr of await this.fetchClosedByMrs(number)) {
				if (seen.has(mr.iid)) continue;
				seen.add(mr.iid);
				results.push(convertClosedByMr(mr));
			}
		} catch {
			// A failed closed_by read contributes nothing.
		}

		try {
			for (const mr of await this.fetchLinkedMrs(number)) {
				if (seen.has(mr.iid)) continue;
				seen.add(mr.iid);
				results.push(mr);
			}
		} catch {
			// A failed links read contributes nothing.
		}

		try {
			const issue = await this.getIssue(undefined, number);
			for (const ref of parseInlineMrReferences(issue.description)) {
				if (seen.has(ref)) continue;
				try {
					const mr = await this.fetchMrByIid(ref);
					seen.add(ref);
					results.push(mr);
				} catch {
					// A reference that does not resolve is skipped.
				}
			}
		} catch {
			// Without the issue body there are no inline references.
		}

		return results;
	}

	private async fetchClosedByMrs(issueIid: number): Promise<RawClosedByMr[]> {
		const response = await this.client.request(
			`${this.base}/issues/${issueIid}/closed_by`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitLab API error (status ${response.status}): ${response.body}`,
			);
		return parseArray<RawClosedByMr>(
			response.body,
			"failed to parse closed_by MRs",
		);
	}

	/** Merge requests linked through GitLab's issue-links feature. */
	private async fetchLinkedMrs(issueIid: number): Promise<ChangeRequestLike[]> {
		const response = await this.client.request(
			`${this.base}/issues/${issueIid}/links`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitLab API error fetching links (status ${response.status}): ${response.body}`,
			);
		const links = parseArray<{
			link_type: string;
			target?: {
				id: number;
				iid: number;
				title: string;
				state: string;
				type: string;
				web_url: string;
				created_at: string;
				updated_at: string;
				author?: { name: string; username: string };
			} | null;
		}>(response.body, "failed to parse issue links");
		return links
			.filter((link) => link.target && link.target.type === "merge_request")
			.map((link) => {
				const target = link.target as NonNullable<typeof link.target>;
				return {
					id: target.id,
					iid: target.iid,
					title: target.title,
					description: "",
					source_branch: "",
					target_branch: "",
					state: target.state,
					web_url: target.web_url,
					created_at: parseGitLabTime(target.created_at),
					updated_at: parseGitLabTime(target.updated_at),
					author: {
						name: target.author?.name ?? "",
						username: target.author?.username ?? "",
					},
					merge_status: "checked",
					detailed_merge_status: "checked",
					draft: false,
					work_in_progress: false,
					has_conflicts: false,
					blocking_discussions_resolved: true,
					rebase_in_progress: false,
					merge_error: "",
				};
			});
	}

	private async fetchMrByIid(mrIid: number): Promise<ChangeRequestLike> {
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitLab API error fetching MR (status ${response.status}): ${response.body}`,
			);
		return convertClosedByMr(
			parseObject<RawClosedByMr>(response.body, "failed to parse MR response"),
		);
	}

	/** Issues referenced by bare `#123` in an issue body. */
	async getIssueReferencedIssues(
		_info: IssueRepoInfo | undefined,
		number: number,
	): Promise<Issue[]> {
		const issue = await this.getIssue(undefined, number);
		const refs = parseReferencedIssueRefs(issue.description);
		if (refs.length === 0) return [];
		const results: Issue[] = [];
		const seen = new Set<number>();
		for (const ref of refs) {
			if (seen.has(ref)) continue;
			seen.add(ref);
			const referenced = await this.fetchIssueOrNull(ref);
			if (referenced) results.push(referenced);
		}
		return results;
	}

	/** Issues linked to a change request: the `closes_issues` endpoint first,
	 * then `#123` references in the merge-request description. */
	async getChangeRequestLinkedIssues(
		_info: IssueRepoInfo,
		number: number,
	): Promise<Issue[]> {
		const results: Issue[] = [];
		const seen = new Set<number>();

		try {
			const response = await this.client.request(
				`${this.base}/merge_requests/${number}/closes_issues`,
			);
			if (response.status === 200) {
				for (const issue of parseArray<RawIssue>(
					response.body,
					"failed to parse closes_issues",
				)) {
					if (seen.has(issue.iid)) continue;
					seen.add(issue.iid);
					// The Go conversion did not copy the timestamps of a
					// closes_issues entry, so they render as the zero time.
					results.push({
						...convertIssue(issue),
						created_at: "0001-01-01T00:00:00Z",
						updated_at: "0001-01-01T00:00:00Z",
					});
				}
			}
		} catch {
			// A failed closes_issues read contributes nothing.
		}

		const detail = await this.client.request(
			`${this.base}/merge_requests/${number}`,
		);
		if (detail.status === 200) {
			let description = "";
			try {
				description =
					(JSON.parse(detail.body) as { description?: string }).description ??
					"";
			} catch {
				description = "";
			}
			if (description !== "") {
				for (const ref of parseReferencedIssueRefs(description)) {
					if (seen.has(ref)) continue;
					const issue = await this.fetchIssueOrNull(ref);
					if (!issue) continue;
					seen.add(ref);
					results.push(issue);
				}
			}
		}
		return results;
	}

	private async fetchIssueOrNull(number: number): Promise<Issue | null> {
		const response = await this.client.request(`${this.base}/issues/${number}`);
		if (response.status !== 200) return null;
		try {
			return convertIssue(JSON.parse(response.body) as RawIssue);
		} catch {
			return null;
		}
	}
}

function convertIssue(issue: RawIssue): Issue {
	const result: Issue = {
		id: issue.id,
		iid: issue.iid,
		title: issue.title,
		description: issue.description,
		state: issue.state,
		web_url: issue.web_url,
		author: {
			name: issue.author?.name ?? "",
			username: issue.author?.username ?? "",
		},
		labels: issue.labels ?? [],
		assignees: issue.assignees ?? [],
		created_at: goRfc3339(issue.created_at),
		updated_at: goRfc3339(issue.updated_at),
	};
	if (issue.milestone) result.milestone = { title: issue.milestone.title };
	return result;
}

function convertNote(note: RawNote): IssueComment {
	return {
		id: note.id,
		body: note.body,
		author: {
			name: note.author?.name ?? "",
			username: note.author?.username ?? "",
		},
		created_at: goRfc3339(note.created_at),
		updated_at: goRfc3339(note.updated_at),
		system: note.system,
	};
}

/** The `closed_by`/detail projection the issue routes return. */
function convertClosedByMr(mr: RawClosedByMr): ChangeRequestLike {
	const result: ChangeRequestLike = {
		id: mr.id,
		iid: mr.iid,
		title: mr.title,
		description: mr.description,
		source_branch: mr.source_branch,
		target_branch: mr.target_branch,
		state: mr.state,
		web_url: mr.web_url,
		// The Go conversion did not copy the timestamps of a closed_by entry,
		// so they render as the zero time.
		created_at: "0001-01-01T00:00:00Z",
		updated_at: "0001-01-01T00:00:00Z",
		author: {
			name: mr.author?.name ?? "",
			username: mr.author?.username ?? "",
		},
		merge_status: mr.merge_status,
		// The Go conversion hard-coded this for closed_by entries.
		detailed_merge_status: "checked",
		draft: mr.draft,
		work_in_progress: mr.work_in_progress,
		has_conflicts: mr.has_conflicts,
		blocking_discussions_resolved: mr.blocking_discussions_resolved,
		rebase_in_progress: false,
		merge_error: "",
	};
	if (mr.head_pipeline)
		result.head_pipeline = {
			id: mr.head_pipeline.id,
			status: mr.head_pipeline.status,
			web_url: mr.head_pipeline.web_url,
		};
	return result;
}

/** Go parsed RFC3339 and reported the zero time for anything else. */
function parseGitLabTime(value: string): string {
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return "0001-01-01T00:00:00Z";
	return goRfc3339(value);
}

function parseArray<T>(body: string, message: string): T[] {
	try {
		const parsed = JSON.parse(body);
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch (error) {
		throw new Error(
			`${message}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function parseObject<T>(body: string, message: string): T {
	try {
		return JSON.parse(body) as T;
	} catch (error) {
		throw new Error(
			`${message}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
