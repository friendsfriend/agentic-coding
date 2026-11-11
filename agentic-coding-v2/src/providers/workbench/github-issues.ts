// GitHub issue capability (`port-git-providers-and-ai-to-bun`, task 3.1),
// ported from `server/pkg/github/issues_client.go` and
// `{issue_linked_mrs,issue_referenced_issues,mr_linked_issues}.go`.
//
// Behavior reproduced as-is, including the parts that look surprising:
//   - `state=all` cannot be expressed in GitHub's search API, so it falls back
//     to the list endpoint, which reports no total and is filtered for pull
//     requests after parsing.
//   - Issue search does not clamp the page size (only repository search does).
//   - Issue comments merge timeline events as system notes; the timeline is
//     best-effort and a failure never fails the comment list.
//   - Linked change requests come from closing keywords in the body first,
//     then from timeline cross-references, deduplicated by number.

import type { GitHubChangeRequests } from "./github-changerequest.ts";
import {
	type GitHubClient,
	parseLinkHeaderForPagination,
	sortedParams,
} from "./github-client.ts";
import type { ChangeRequestLike } from "./issues.ts";
import {
	authorOf,
	type Issue,
	type IssueClient,
	type IssueComment,
	type IssueCommentListResult,
	type IssueListOptions,
	type IssueListResult,
	type IssueRepoInfo,
	issueFromRaw,
	type RawIssuePayload,
} from "./issues.ts";

/** Closing-keyword and cross-reference patterns, in the Go order. */
const CLOSING_REF_PATTERNS: readonly RegExp[] = [
	/(?:close(?:s|d)?(?:\s+by)?\s*:?\s*#?(\d+))\b/gi,
	/(?:fix(?:es|ed)?\s*:?\s*#?(\d+))\b/gi,
	/(?:resolve(?:s|d)?\s*:?\s*#?(\d+))\b/gi,
	/(?:close|fix|resolve|closed by|fixes|resolves|closes)\s+(?:issue\s+)?#?(\d+)\b/gi,
	/GH[-\s]?(\d+)\b/gi,
	/(?:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)#(\d+)\b/gi,
	/#(\d+)\b/gi,
];

/** Reference numbers from an issue or change-request body, deduplicated in
 * pattern order. */
export function parseClosingReferences(body: string): number[] {
	const seen = new Set<number>();
	const refs: number[] = [];
	for (const pattern of CLOSING_REF_PATTERNS) {
		for (const match of body.matchAll(pattern)) {
			const num = Number(match[1]);
			if (!Number.isInteger(num)) continue;
			if (seen.has(num)) continue;
			seen.add(num);
			refs.push(num);
		}
	}
	return refs;
}

interface RawIssue extends RawIssuePayload {
	pull_request?: unknown;
}

interface RawIssueComment {
	id: number;
	body: string;
	user?: { login: string };
	created_at: string;
	updated_at: string;
}

interface RawTimelineEvent {
	id: number;
	event: string;
	actor?: { login: string };
	created_at: string;
	label?: { name: string } | null;
	assignee?: { login: string } | null;
	rename?: { from: string; to: string } | null;
	milestone?: { title: string } | null;
	requested_reviewer?: { login: string } | null;
	source?: { issue?: { number: number; title: string } | null } | null;
}

/** Issue timeline event to the system note body (the issue variant, which has
 * fewer cases than the change-request one). */
export function timelineEventToCommentBody(event: RawTimelineEvent): string {
	switch (event.event) {
		case "labeled":
			return event.label ? `added ~${event.label.name} label` : "added label";
		case "unlabeled":
			return event.label
				? `removed ~${event.label.name} label`
				: "removed label";
		case "assigned":
			return event.assignee
				? `assigned to @${event.assignee.login}`
				: "assigned";
		case "unassigned":
			return event.assignee
				? `unassigned @${event.assignee.login}`
				: "unassigned";
		case "milestoned":
			return event.milestone
				? `added to milestone **${event.milestone.title}**`
				: "added to milestone";
		case "demilestoned":
			return event.milestone
				? `removed from milestone **${event.milestone.title}**`
				: "removed from milestone";
		case "renamed":
			return event.rename
				? `changed title from **${event.rename.from}** to **${event.rename.to}**`
				: "changed title";
		case "locked":
			return "locked the conversation";
		case "unlocked":
			return "unlocked the conversation";
		case "closed":
			return "closed";
		case "reopened":
			return "reopened";
		case "cross-referenced":
			return event.source?.issue
				? `mentioned in #${event.source.issue.number} ${event.source.issue.title}`
				: "mentioned in another issue";
		case "review_requested":
			return event.requested_reviewer
				? `requested review from @${event.requested_reviewer.login}`
				: "requested review";
		case "review_request_removed":
			return event.requested_reviewer
				? `removed review request from @${event.requested_reviewer.login}`
				: "removed review request";
		case "ready_for_review":
			return "marked as ready for review";
		case "head_ref_deleted":
			return "deleted the head branch";
		case "head_ref_restored":
			return "restored the head branch";
		case "base_ref_changed":
			return "changed the base branch";
		case "committed":
			return "added a commit";
		case "subscribed":
			return "subscribed";
		case "unsubscribed":
			return "unsubscribed";
		case "pinned":
			return "pinned";
		case "unpinned":
			return "unpinned";
		case "marked_as_duplicate":
			return "marked as duplicate";
		case "unmarked_as_duplicate":
			return "unmarked as duplicate";
		default:
			return event.event;
	}
}

/** GitHub issue search sort fields (note: `comments`, not `popularity`). */
function normalizeIssueSort(sortBy: string): string {
	switch (sortBy) {
		case "created":
		case "updated":
		case "comments":
			return sortBy;
		default:
			return "updated";
	}
}

export class GitHubIssues implements IssueClient {
	private readonly client: GitHubClient;
	private readonly changeRequests: GitHubChangeRequests;
	private readonly fallback: IssueRepoInfo;

	constructor(
		client: GitHubClient,
		repoInfo: IssueRepoInfo,
		changeRequests: GitHubChangeRequests,
	) {
		this.client = client;
		this.changeRequests = changeRequests;
		this.fallback = repoInfo;
	}

	private get baseUrl(): string {
		return this.client.baseUrl;
	}

	private repo(info: IssueRepoInfo | undefined): IssueRepoInfo {
		if (info && info.owner !== "" && info.repo !== "")
			return { owner: info.owner, repo: info.repo };
		return this.fallback;
	}

	async getIssues(
		info: IssueRepoInfo | undefined,
		options: IssueListOptions = {},
	): Promise<IssueListResult> {
		const repo = this.repo(info);
		const page = options.page && options.page > 0 ? options.page : 1;
		const perPage =
			options.perPage && options.perPage > 0 ? options.perPage : 50;
		const state =
			options.state !== undefined && options.state !== ""
				? options.state
				: "open";
		const sortBy =
			options.sortBy !== undefined && options.sortBy !== ""
				? options.sortBy
				: "updated";
		const order =
			options.sortDirection === "asc" || options.sortDirection === "desc"
				? options.sortDirection
				: "desc";
		const scope = options.scope ?? "";
		const search = options.search ?? "";
		const labels = options.labels ?? [];

		if (state === "all")
			return this.listAllIssues(
				repo,
				scope,
				search,
				page,
				perPage,
				sortBy,
				order,
				labels,
			);

		// The scope becomes a search qualifier: GitHub's `filter` parameter does
		// not work with fine-grained tokens.
		const scopeQuery =
			scope === "assigned-to-me"
				? "assignee:@me"
				: scope === "created-by-me"
					? "author:@me"
					: scope === "no-assignee"
						? "no:assignee"
						: "";
		let query = search;
		if (scopeQuery !== "")
			query = query !== "" ? `${query} ${scopeQuery}` : scopeQuery;
		return this.searchIssues(
			repo,
			query,
			page,
			perPage,
			state,
			sortBy,
			order,
			labels,
		);
	}

	private async searchIssues(
		repo: IssueRepoInfo,
		query: string,
		page: number,
		perPage: number,
		state: string,
		sortBy: string,
		order: string,
		labels: readonly string[],
	): Promise<IssueListResult> {
		const labelQuery = labels.map((label) => ` label:"${label}"`).join("");
		const searchQuery =
			`repo:${repo.owner}/${repo.repo} type:issue state:${state} ${query} ${labelQuery}`.trim();
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/search/issues?${sortedParams({
				q: searchQuery,
				per_page: String(perPage),
				page: String(page),
				sort: normalizeIssueSort(sortBy),
				order,
			})}`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitHub search API error (status ${response.status}): ${response.body}`,
			);
		let parsed: unknown;
		try {
			parsed = JSON.parse(response.body);
		} catch (error) {
			throw new Error(
				`failed to parse search results: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const totalCount = Number(
			(parsed as { total_count?: unknown }).total_count ?? 0,
		);
		const items = Array.isArray((parsed as { items?: unknown }).items)
			? ((parsed as { items: RawIssue[] }).items ?? [])
			: [];
		const results = items
			.filter(
				(item) => item.pull_request === undefined || item.pull_request === null,
			)
			.map(issueFromRaw);
		return {
			items: results,
			totalCount,
			// The total count is authoritative for search, so it replaces the
			// Link-header page count.
			totalPages: Math.trunc((totalCount + perPage - 1) / perPage),
			currentPage: page,
			perPage,
		};
	}

	private async listAllIssues(
		repo: IssueRepoInfo,
		scope: string,
		search: string,
		page: number,
		perPage: number,
		sortBy: string,
		order: string,
		labels: readonly string[],
	): Promise<IssueListResult> {
		const params: Record<string, string> = {
			state: "all",
			page: String(page),
			per_page: String(perPage),
			sort: normalizeIssueSort(sortBy),
			direction: order,
		};
		// Scope filtering on this endpoint is best-effort: `filter` does not work
		// with fine-grained tokens and unassigned has no equivalent at all.
		if (scope === "assigned-to-me") params.filter = "assigned";
		if (scope === "created-by-me") params.filter = "created";
		if (labels.length > 0) params.labels = labels.join(",");
		if (search !== "") params.q = search;

		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${repo.owner}/${repo.repo}/issues?${sortedParams(params)}`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitHub API error listing issues (status ${response.status}): ${response.body}`,
			);
		const { page: currentPage, totalPages } = parseLinkHeaderForPagination(
			response.headers.get("Link") ?? "",
			page,
		);
		const items = parseArray<RawIssue>(response.body, "failed to parse issues");
		return {
			items: items
				.filter(
					(item) =>
						item.pull_request === undefined || item.pull_request === null,
				)
				.map(issueFromRaw),
			totalCount: -1,
			totalPages,
			currentPage,
			perPage,
		};
	}

	async getIssue(
		info: IssueRepoInfo | undefined,
		number: number,
	): Promise<Issue> {
		const repo = this.repo(info);
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${repo.owner}/${repo.repo}/issues/${number}`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
		try {
			return issueFromRaw(JSON.parse(response.body) as RawIssue);
		} catch (error) {
			throw new Error(
				`failed to parse issue: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** Regular comments plus timeline events as system notes, matching GitLab's
	 * behavior where system notes appear in the comments list. */
	async getIssueComments(
		info: IssueRepoInfo | undefined,
		number: number,
	): Promise<IssueCommentListResult> {
		const repo = this.repo(info);
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${repo.owner}/${repo.repo}/issues/${number}/comments?per_page=100`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
		const comments = parseArray<RawIssueComment>(
			response.body,
			"failed to parse issue comments",
		);
		const items: IssueComment[] = comments.map((comment) => ({
			id: comment.id,
			body: comment.body,
			author: authorOf(comment.user?.login ?? ""),
			created_at: comment.created_at,
			updated_at: comment.updated_at,
			system: false,
		}));

		const timeline = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${repo.owner}/${repo.repo}/issues/${number}/timeline?per_page=100`,
		);
		if (timeline.status === 200) {
			for (const event of parseArrayOrEmpty<RawTimelineEvent>(timeline.body)) {
				if (event.event === "commented" || event.event === "") continue;
				const author = event.actor?.login ?? "";
				items.push({
					id: event.id,
					body: timelineEventToCommentBody(event),
					author: authorOf(author === "" ? "unknown" : author),
					created_at: event.created_at,
					updated_at: event.created_at,
					system: true,
				});
			}
		}

		const { totalPages } = parseLinkHeaderForPagination(
			response.headers.get("Link") ?? "",
			1,
		);
		return {
			items,
			totalCount: -1,
			totalPages,
			currentPage: 1,
			perPage: 100,
		};
	}

	// ---- Mutations ----

	async closeIssue(
		info: IssueRepoInfo | undefined,
		number: number,
		reason: string,
	): Promise<Issue> {
		const payload: Record<string, string> = { state: "closed" };
		if (reason !== "") payload.state_reason = reason;
		return this.patchIssue(
			info,
			number,
			JSON.stringify(payload),
			"closed issue",
		);
	}

	async reopenIssue(
		info: IssueRepoInfo | undefined,
		number: number,
	): Promise<Issue> {
		return this.patchIssue(
			info,
			number,
			JSON.stringify({ state: "open" }),
			"reopened issue",
		);
	}

	private async patchIssue(
		info: IssueRepoInfo | undefined,
		number: number,
		body: string,
		label: string,
	): Promise<Issue> {
		const repo = this.repo(info);
		const response = await this.client.request(
			"PATCH",
			`${this.baseUrl}/repos/${repo.owner}/${repo.repo}/issues/${number}`,
			body,
		);
		if (response.status !== 200)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
		try {
			return issueFromRaw(JSON.parse(response.body) as RawIssue);
		} catch (error) {
			throw new Error(
				`failed to parse ${label}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async setLabels(
		info: IssueRepoInfo | undefined,
		number: number,
		labels: string[],
	): Promise<Issue> {
		const repo = this.repo(info);
		const response = await this.client.request(
			"PUT",
			`${this.baseUrl}/repos/${repo.owner}/${repo.repo}/issues/${number}/labels`,
			JSON.stringify({ labels }),
		);
		if (response.status !== 200)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
		return this.getIssue(info, number);
	}

	async addAssignee(
		info: IssueRepoInfo | undefined,
		number: number,
		assignee: string,
	): Promise<Issue> {
		return this.assignees(info, number, [assignee], "POST");
	}

	async removeAssignee(
		info: IssueRepoInfo | undefined,
		number: number,
	): Promise<Issue> {
		return this.assignees(info, number, [], "DELETE");
	}

	private async assignees(
		info: IssueRepoInfo | undefined,
		number: number,
		assignees: string[],
		method: "POST" | "DELETE",
	): Promise<Issue> {
		const repo = this.repo(info);
		const response = await this.client.request(
			method,
			`${this.baseUrl}/repos/${repo.owner}/${repo.repo}/issues/${number}/assignees`,
			JSON.stringify({ assignees }),
		);
		if (response.status !== 200)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
		return this.getIssue(info, number);
	}

	async addComment(
		info: IssueRepoInfo | undefined,
		number: number,
		body: string,
	): Promise<IssueComment> {
		const repo = this.repo(info);
		const response = await this.client.request(
			"POST",
			`${this.baseUrl}/repos/${repo.owner}/${repo.repo}/issues/${number}/comments`,
			JSON.stringify({ body }),
		);
		if (response.status !== 201)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
		let comment: RawIssueComment;
		try {
			comment = JSON.parse(response.body) as RawIssueComment;
		} catch (error) {
			throw new Error(
				`failed to parse comment: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return {
			id: comment.id,
			body: comment.body,
			author: authorOf(comment.user?.login ?? ""),
			created_at: comment.created_at,
			updated_at: comment.updated_at,
			system: false,
		};
	}

	async getRepoLabels(info: IssueRepoInfo | undefined): Promise<string[]> {
		const repo = this.repo(info);
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${repo.owner}/${repo.repo}/labels?per_page=100`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
		return parseArray<{ name: string }>(
			response.body,
			"failed to parse labels",
		).map((label) => label.name);
	}

	async getRepoCollaborators(
		info: IssueRepoInfo | undefined,
	): Promise<string[]> {
		const repo = this.repo(info);
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${repo.owner}/${repo.repo}/collaborators?per_page=100`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
		return parseArray<{ login: string }>(
			response.body,
			"failed to parse collaborators",
		).map((user) => user.login);
	}

	// ---- Linked and referenced items ----

	/** Change requests linked to an issue: closing keywords in the body first,
	 * then timeline cross-references, deduplicated. */
	async getIssueLinkedChangeRequests(
		info: IssueRepoInfo | undefined,
		number: number,
	): Promise<ChangeRequestLike[]> {
		const repo = this.repo(info);
		const seen = new Set<number>();
		const results: ChangeRequestLike[] = [];

		try {
			const issue = await this.getIssue(info, number);
			for (const ref of parseClosingReferences(issue.description)) {
				if (seen.has(ref)) continue;
				seen.add(ref);
				const cr = await this.fetchPullRequestLike(repo, ref);
				if (cr) results.push(cr);
			}
		} catch {
			// A missing issue body simply contributes no references.
		}

		for (const ref of await this.fetchCrossReferencedPrs(repo, number)) {
			if (seen.has(ref)) continue;
			seen.add(ref);
			const cr = await this.fetchPullRequestLike(repo, ref);
			if (cr) results.push(cr);
		}
		return results;
	}

	/** Pull request numbers from the issue timeline's cross-referenced events. */
	private async fetchCrossReferencedPrs(
		repo: IssueRepoInfo,
		issueNumber: number,
	): Promise<number[]> {
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/timeline?per_page=100`,
		);
		if (response.status !== 200) return [];
		const seen = new Set<number>();
		const refs: number[] = [];
		for (const event of parseArrayOrEmpty<{
			event: string;
			source?: {
				issue?: { number: number; pull_request?: unknown } | null;
			} | null;
		}>(response.body)) {
			if (event.event !== "cross-referenced" || !event.source?.issue) continue;
			// Only a pull request source counts.
			if (
				event.source.issue.pull_request === undefined ||
				event.source.issue.pull_request === null
			)
				continue;
			const number = event.source.issue.number;
			if (seen.has(number)) continue;
			seen.add(number);
			refs.push(number);
		}
		return refs;
	}

	/** One linked change request in the shape the issue routes return: the pull
	 * request detail without its approvals or default branch, exactly as the Go
	 * conversion copied it. */
	private async fetchPullRequestLike(
		repo: IssueRepoInfo,
		number: number,
	): Promise<ChangeRequestLike | null> {
		try {
			const pr = await this.changeRequests.getPullRequest(repo, number);
			const linked: ChangeRequestLike = { ...pr };
			delete linked.approvals;
			delete linked.default_branch;
			return linked;
		} catch {
			// A reference that does not resolve to a readable PR is skipped.
			return null;
		}
	}

	/** Issues referenced in an issue body, excluding pull requests and
	 * unreadable references. */
	async getIssueReferencedIssues(
		info: IssueRepoInfo | undefined,
		number: number,
	): Promise<Issue[]> {
		const repo = this.repo(info);
		const issue = await this.getIssue(info, number);
		const refs = parseClosingReferences(issue.description);
		if (refs.length === 0) return [];
		const results: Issue[] = [];
		const seen = new Set<number>();
		for (const ref of refs) {
			if (seen.has(ref)) continue;
			seen.add(ref);
			const referenced = await this.fetchIssueLike(repo, ref);
			if (referenced) results.push(referenced);
		}
		return results;
	}

	/** Issues referenced in a change-request body, excluding pull requests. */
	async getChangeRequestLinkedIssues(
		info: IssueRepoInfo,
		number: number,
	): Promise<Issue[]> {
		const pr = await this.changeRequests.getPullRequest(info, number);
		const refs = parseClosingReferences(pr.description);
		if (refs.length === 0) return [];
		const results: Issue[] = [];
		const seen = new Set<number>();
		for (const ref of refs) {
			if (seen.has(ref)) continue;
			seen.add(ref);
			const issue = await this.fetchIssueLike(info, ref);
			if (issue) results.push(issue);
		}
		return results;
	}

	private async fetchIssueLike(
		repo: IssueRepoInfo,
		number: number,
	): Promise<Issue | null> {
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${repo.owner}/${repo.repo}/issues/${number}`,
		);
		if (response.status !== 200) return null;
		let raw: RawIssue;
		try {
			raw = JSON.parse(response.body) as RawIssue;
		} catch {
			return null;
		}
		if (raw.pull_request !== undefined && raw.pull_request !== null)
			return null;
		return issueFromRaw(raw);
	}
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

function parseArrayOrEmpty<T>(body: string): T[] {
	try {
		const parsed = JSON.parse(body);
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}
