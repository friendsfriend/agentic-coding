// GitHub change-request capability (`port-git-providers-and-ai-to-bun`,
// tasks 3.3-3.4), ported from `server/pkg/github/{pull_requests,changes,diff,
// discussions,approvals,comments,actions}.go` plus the CI parts of
// `client.go`.
//
// Deliberate differences from the Go implementation:
//   - `approved_by` is sorted by username. The Go client iterated a map, so its
//     order was incidental; a stable order is required for a fixture to be a
//     contract at all.
//   - The client is an object with an injectable `fetch` instead of a global
//     HTTP client, so fixtures replay recorded provider responses.
// Everything else — request shape, page-size handling, state mapping, review
// dismissal, diff line identity — is reproduced as-is.
import {
	type Approvals,
	type ChangeRequest,
	type ChangeRequestChange,
	type ChangeRequestListResult,
	type CiJob,
	type DiffPosition,
	type Discussion,
	type Note,
	parseDiffLines,
	sortApprovals,
} from "./changerequest.ts";
import {
	type GitHubClient,
	type GitHubRepoInfo,
	type GitHubResponse,
	parseLinkHeaderForPagination,
	sortedParams,
} from "./github-client.ts";

/** Subset of the provider PR payload the port reads. */
interface RawPullRequest {
	id: number;
	number: number;
	title: string;
	body: string;
	state: string;
	merged?: boolean;
	draft?: boolean;
	html_url: string;
	created_at: string;
	updated_at: string;
	user?: { login: string };
	head?: { ref?: string; sha?: string; repo?: { default_branch?: string } };
	base?: { ref?: string; sha?: string; repo?: { default_branch?: string } };
	mergeable?: boolean | null;
	mergeable_state?: string;
}

interface RawReview {
	id: number;
	user?: { login: string };
	state: string;
}

interface RawReviewComment {
	id: number;
	body: string;
	user?: { login: string };
	created_at: string;
	updated_at: string;
	path: string;
	in_reply_to_id?: number | null;
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
	source?: {
		type?: string;
		issue?: { number: number; title: string } | null;
	} | null;
}

interface RawWorkflowRun {
	id: number;
	name: string;
	status: string;
	conclusion: string;
	html_url: string;
	created_at: string;
	updated_at: string;
	head_sha: string;
	head_branch: string;
}

interface RawActionJob {
	id: number;
	name: string;
	status: string;
	conclusion: string;
	started_at: string;
	completed_at: string;
	html_url: string;
	run_id: number;
}

interface RawCheckRun {
	name: string;
	status: string;
	output: { summary: string };
}

export interface ChangeRequestListOptions {
	sourceBranch?: string;
	targetBranch?: string;
	state?: string;
	page?: number;
	perPage?: number;
	search?: string;
	labels?: string[];
	sortBy?: string;
	sortDirection?: string;
	skipDetails?: boolean;
}

/** Map a workflow run or job status onto the GitLab status vocabulary. */
export function mapRunStatusToGitLab(run: {
	status: string;
	conclusion: string;
}): string {
	switch (run.status) {
		case "queued":
		case "waiting":
		case "pending":
			return "pending";
		case "in progress":
			return "running";
		case "completed":
			switch (run.conclusion) {
				case "success":
				case "neutral":
				case "skipped":
					return "success";
				case "failure":
				case "timed_out":
					return "failed";
				case "cancelled":
					return "canceled";
				default:
					return "running";
			}
		default:
			return "running";
	}
}

/** Search sort fields GitHub accepts for issues and pull requests. */
function normalizeSearchSort(sortBy: string): string {
	switch (sortBy) {
		case "created":
		case "updated":
		case "comments":
			return sortBy;
		default:
			return "updated";
	}
}

/** Search sort fields GitHub accepts for the pull-request list endpoint. */
function normalizePullSort(sortBy: string): string {
	switch (sortBy) {
		case "created":
		case "updated":
		case "popularity":
		case "long-running":
			return sortBy;
		default:
			return "updated";
	}
}

function prState(pr: RawPullRequest): string {
	if (pr.merged) return "merged";
	if (pr.state === "closed") return "closed";
	return "opened";
}

function mergeability(pr: RawPullRequest): {
	mergeStatus: string;
	detailed: string;
	hasConflicts: boolean;
} {
	if (pr.mergeable === undefined || pr.mergeable === null)
		return {
			mergeStatus: "checking",
			detailed: "checking",
			hasConflicts: false,
		};
	if (pr.mergeable)
		return {
			mergeStatus: "can_be_merged",
			detailed: pr.mergeable_state ?? "",
			hasConflicts: false,
		};
	if (pr.mergeable_state === "dirty")
		return {
			mergeStatus: "cannot_be_merged",
			detailed: pr.mergeable_state,
			hasConflicts: true,
		};
	return {
		mergeStatus: "cannot_be_merged",
		detailed: pr.mergeable_state ?? "",
		hasConflicts: false,
	};
}

/** Timeline event to the human-readable system note the TUI renders. */
export function timelineEventToBody(event: RawTimelineEvent): string {
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
		case "merged":
			return "merged the commit";
		case "closed":
			return "closed";
		case "reopened":
			return "reopened";
		case "head_ref_deleted":
			return "deleted the head branch";
		case "head_ref_restored":
			return "restored the head branch";
		case "cross-referenced":
			return event.source?.issue
				? `mentioned in #${event.source.issue.number} ${event.source.issue.title}`
				: "mentioned in another issue";
		case "base_ref_changed":
			return "changed the base branch";
		case "reviewed":
			return "submitted a review";
		case "committed":
			return "added a commit";
		case "comment_removed":
			return "removed a comment";
		case "marked_as_duplicate":
			return "marked as duplicate";
		case "unmarked_as_duplicate":
			return "unmarked as duplicate";
		case "converted_note_to_issue":
			return "converted to issue";
		case "transferred":
			return "transferred";
		case "subscribed":
			return "subscribed";
		case "unsubscribed":
			return "unsubscribed";
		case "pinned":
			return "pinned";
		case "unpinned":
			return "unpinned";
		case "automatic_base_change_failed":
			return "automatic base change failed";
		case "automatic_base_change_succeeded":
			return "automatic base change succeeded";
		default:
			return event.event;
	}
}

export class GitHubChangeRequests {
	private readonly client: GitHubClient;

	constructor(client: GitHubClient) {
		this.client = client;
	}

	private get baseUrl(): string {
		return this.client.baseUrl;
	}

	private repo(
		info: GitHubRepoInfo | undefined,
		fallback: GitHubRepoInfo,
	): GitHubRepoInfo {
		if (info && info.owner !== "" && info.repo !== "")
			return { owner: info.owner, repo: info.repo };
		return fallback;
	}

	// ---- Change request list and detail ----

	async getChangeRequests(
		info: GitHubRepoInfo,
		options: ChangeRequestListOptions = {},
	): Promise<ChangeRequestListResult> {
		const page = options.page && options.page > 0 ? options.page : 1;
		const perPage =
			options.perPage && options.perPage > 0 ? options.perPage : 50;
		const state =
			options.state !== undefined && options.state !== ""
				? options.state
				: "open";
		const sortBy =
			options.sortBy && options.sortBy !== "" ? options.sortBy : "updated";
		const order =
			options.sortDirection === "asc" || options.sortDirection === "desc"
				? options.sortDirection
				: "desc";
		const search = options.search ?? "";
		const labels = options.labels ?? [];
		const skipDetails = options.skipDetails ?? false;

		if (search !== "" || labels.length > 0)
			return this.searchPullRequests(
				info,
				search,
				page,
				perPage,
				state,
				skipDetails,
				sortBy,
				order,
				labels,
			);

		const apiState =
			state === "closed" ? "closed" : state === "opened" ? "open" : state;
		const params: Record<string, string> = {
			state: apiState,
			per_page: String(perPage),
			page: String(page),
			sort: normalizePullSort(sortBy),
			direction: order,
		};
		if (options.sourceBranch)
			params.head = `${info.owner}:${options.sourceBranch}`;
		if (options.targetBranch) params.base = options.targetBranch;

		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/pulls?${sortedParams(params)}`,
		);
		const body = this.expectOk(response, "GitHub API error");
		const { page: currentPage, totalPages } = parseLinkHeaderForPagination(
			response.headers.get("Link") ?? "",
			page,
		);
		const pulls = parseArray<RawPullRequest>(
			body,
			"failed to parse pull requests",
		);

		const results: ChangeRequest[] = [];
		for (const pr of pulls) {
			let approvals: Approvals | undefined;
			let latestRun: RawWorkflowRun | undefined;
			if (!skipDetails) {
				try {
					approvals = await this.getPrApprovals(info, pr.number);
				} catch {
					// A missing approval read is not a reason to drop the PR.
				}
				try {
					latestRun =
						(await this.getLatestRunForSha(info, pr.head?.sha ?? "")) ??
						undefined;
				} catch {
					// Same for a missing workflow run.
				}
			}
			results.push(convertPullRequest(pr, approvals, latestRun));
		}

		return {
			items: results,
			totalCount: -1,
			totalPages,
			currentPage,
			perPage,
		};
	}

	/** Search pull requests through `/search/issues` (`type:pr`), which is the
	 * only GitHub endpoint that supports free-text search. */
	private async searchPullRequests(
		info: GitHubRepoInfo,
		query: string,
		page: number,
		perPage: number,
		state: string,
		skipDetails: boolean,
		sortBy: string,
		order: string,
		labels: readonly string[],
	): Promise<ChangeRequestListResult> {
		const labelQuery = labels.map((label) => ` label:"${label}"`).join("");
		const searchQuery =
			`repo:${info.owner}/${info.repo} type:pr state:${state} ${query} ${labelQuery}`.trim();
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/search/issues?${sortedParams({
				q: searchQuery,
				per_page: String(perPage),
				page: String(page),
				sort: normalizeSearchSort(sortBy),
				order,
			})}`,
		);
		const body = this.expectOk(response, "GitHub search API error");
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch (error) {
			throw new Error(
				`failed to parse search results: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const totalCount = Number(
			(parsed as { total_count?: unknown }).total_count ?? 0,
		);
		const items = Array.isArray((parsed as { items?: unknown }).items)
			? ((parsed as { items: Record<string, unknown>[] }).items ?? [])
			: [];

		const results: ChangeRequest[] = [];
		for (const item of items) {
			const number = Number(item.number ?? 0);
			if (!skipDetails) {
				try {
					const full = await this.getPullRequest(info, number);
					// The Go client rebuilt a partial provider payload here, so the
					// id and mergeability of a search hit are not carried over; the
					// approvals and pipeline reference are copied explicitly.
					const partial: RawPullRequest = {
						id: 0,
						number: full.iid,
						title: full.title,
						body: full.description,
						state: full.state,
						html_url: full.web_url,
						created_at: full.created_at,
						updated_at: full.updated_at,
						user: { login: full.author.username },
						head: { ref: full.source_branch },
						base: { ref: full.target_branch },
					};
					const changeRequest = convertPullRequest(
						partial,
						full.approvals,
						undefined,
					);
					if (full.head_pipeline)
						changeRequest.head_pipeline = full.head_pipeline;
					results.push(changeRequest);
					continue;
				} catch {
					// Fall back to the minimal search result below.
				}
			}
			const author = loginOf(item.user);
			results.push({
				id: 0,
				iid: number,
				title: text(item.title),
				description: text(item.body),
				source_branch: "",
				target_branch: "",
				state: item.state === "closed" ? "closed" : "opened",
				web_url: text(item.html_url),
				created_at: text(item.created_at),
				updated_at: text(item.updated_at),
				author: { name: author, username: author },
				merge_status: "",
				detailed_merge_status: "",
				draft: false,
				work_in_progress: false,
				has_conflicts: false,
				blocking_discussions_resolved: true,
				rebase_in_progress: false,
				merge_error: "",
			});
		}

		return {
			items: results,
			totalCount,
			totalPages: Math.trunc((totalCount + perPage - 1) / perPage),
			currentPage: page,
			perPage,
		};
	}

	/** One pull request with approvals and its latest workflow run. */
	async getPullRequest(
		info: GitHubRepoInfo,
		prNumber: number,
	): Promise<ChangeRequest> {
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/pulls/${prNumber}`,
		);
		const body = this.expectOk(response, "GitHub API error");
		let pr: RawPullRequest;
		try {
			pr = JSON.parse(body) as RawPullRequest;
		} catch (error) {
			throw new Error(
				`failed to parse pull request: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		let approvals: Approvals | undefined;
		try {
			approvals = await this.getPrApprovals(info, prNumber);
		} catch {
			// Approvals are best-effort, exactly as in the Go client.
		}
		let latestRun: RawWorkflowRun | undefined;
		try {
			latestRun =
				(await this.getLatestRunForSha(info, pr.head?.sha ?? "")) ?? undefined;
		} catch {
			// Same for the pipeline reference.
		}
		return convertPullRequest(pr, approvals, latestRun);
	}

	/** Review-based approvals. Only the latest review state per user counts, so
	 * an approval that was later dismissed is not reported. */
	async getPrApprovals(
		info: GitHubRepoInfo,
		prNumber: number,
	): Promise<Approvals> {
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/pulls/${prNumber}/reviews?per_page=100`,
		);
		const body = this.expectOk(response, "GitHub API error");
		const reviews = parseArray<RawReview>(body, "failed to parse reviews");
		const latestByUser = new Map<string, string>();
		for (const review of reviews) {
			const login = review.user?.login ?? "";
			if (login === "") continue;
			latestByUser.set(login, review.state);
		}
		const approvedBy = [...latestByUser.entries()]
			.filter(([, state]) => state === "APPROVED")
			.map(([login]) => ({ user: { name: login, username: login } }));
		const approvals: Approvals = {
			approvals_required: 1,
			approvals_left: 0,
			approved_by: approvedBy,
		};
		approvals.approvals_left =
			approvedBy.length >= approvals.approvals_required
				? 0
				: approvals.approvals_required - approvedBy.length;
		return sortApprovals(approvals);
	}

	async approve(info: GitHubRepoInfo, prNumber: number): Promise<void> {
		const response = await this.client.request(
			"POST",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/pulls/${prNumber}/reviews`,
			JSON.stringify({ event: "APPROVE" }),
		);
		if (response.status !== 200 && response.status !== 201)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
	}

	async unapprove(info: GitHubRepoInfo, prNumber: number): Promise<void> {
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/pulls/${prNumber}/reviews?per_page=100`,
		);
		const body = this.expectOk(response, "GitHub API error");
		const reviews = parseArray<RawReview>(body, "failed to parse reviews");
		let dismissId = 0;
		for (let i = reviews.length - 1; i >= 0; i--) {
			const review = reviews[i];
			if (
				review.state === "APPROVED" &&
				(this.client.username === "" ||
					review.user?.login === this.client.username)
			) {
				dismissId = review.id;
				break;
			}
		}
		if (dismissId === 0) throw new Error("no APPROVED review found to dismiss");
		const dismiss = await this.client.request(
			"PUT",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/pulls/${prNumber}/reviews/${dismissId}/dismissals`,
			JSON.stringify({ message: "Unapproved via devenv-cli" }),
		);
		if (dismiss.status !== 200)
			throw new Error(
				`GitHub API error dismissing review (status ${dismiss.status}): ${dismiss.body}`,
			);
	}

	async toggleApproval(info: GitHubRepoInfo, prNumber: number): Promise<void> {
		const approvals = await this.getPrApprovals(info, prNumber);
		const alreadyApproved = approvals.approved_by.some(
			(entry: { user: { username: string } }) =>
				entry.user.username === this.client.username,
		);
		if (alreadyApproved) return this.unapprove(info, prNumber);
		return this.approve(info, prNumber);
	}

	async close(info: GitHubRepoInfo, prNumber: number): Promise<void> {
		const response = await this.client.request(
			"PATCH",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/pulls/${prNumber}`,
			JSON.stringify({ state: "closed" }),
		);
		if (response.status !== 200)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
	}

	/** GitHub has no server-side rebase. */
	async rebase(_info: GitHubRepoInfo, _prNumber: number): Promise<void> {
		throw new Error("server-side rebase is not supported on GitHub");
	}

	/** GitHub cannot resolve a discussion thread. */
	async resolveDiscussion(
		_info: GitHubRepoInfo,
		_prNumber: number,
		_discussionId: string,
		_resolved: boolean,
	): Promise<void> {
		throw new Error("resolving discussions is not supported on GitHub");
	}

	async createDiffComment(
		info: GitHubRepoInfo,
		prNumber: number,
		body: string,
		position: DiffPosition | undefined,
	): Promise<void> {
		const payload: Record<string, unknown> = { body };
		if (position) {
			payload.commit_id = position.headSha;
			payload.path = position.newPath;
			payload.side = position.oldLine !== undefined ? "LEFT" : "RIGHT";
			if (position.oldLine !== undefined) payload.line = position.oldLine;
			else if (position.newLine !== undefined) payload.line = position.newLine;
		}
		const response = await this.client.request(
			"POST",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/pulls/${prNumber}/comments`,
			sortedJson(payload),
		);
		if (response.status !== 201)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
	}

	async replyToDiscussion(
		info: GitHubRepoInfo,
		prNumber: number,
		discussionId: string,
		body: string,
	): Promise<void> {
		const replyId = Number(discussionId);
		if (!Number.isInteger(replyId))
			throw new Error(`invalid discussion ID: ${discussionId}`);
		const response = await this.client.request(
			"POST",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/pulls/${prNumber}/comments`,
			JSON.stringify({ body, in_reply_to: replyId }),
		);
		if (response.status !== 201)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
	}

	// ---- Diff and discussions ----

	async getChangeRequestChanges(
		info: GitHubRepoInfo,
		prNumber: number,
	): Promise<ChangeRequestChange[]> {
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/pulls/${prNumber}/files?per_page=100`,
		);
		const body = this.expectOk(response, "GitHub API error");
		const files = parseArray<{
			filename: string;
			previous_filename?: string;
			status: string;
			additions: number;
			deletions: number;
			patch?: string;
		}>(body, "failed to parse PR files");

		return files.map((file) => {
			const change: ChangeRequestChange = {
				new_path: file.filename,
				old_path: file.filename,
				a_mode: "100644",
				b_mode: "100644",
				new_file: file.status === "added",
				renamed_file: file.status === "renamed",
				deleted_file: file.status === "removed",
				diff: file.patch ?? "",
				lines_added: file.additions,
				lines_deleted: file.deletions,
			};
			if (file.status === "renamed" && file.previous_filename)
				change.old_path = file.previous_filename;
			if (change.diff !== "")
				change.diff_lines = parseDiffLines(change.diff, file.filename);
			return change;
		});
	}

	/** Review threads (inline), issue comments and timeline events, in that
	 * order — the same composition the Go client produced. */
	async getDiscussions(
		info: GitHubRepoInfo,
		prNumber: number,
	): Promise<Discussion[]> {
		const reviewComments = parseArray<RawReviewComment>(
			this.expectOk(
				await this.client.request(
					"GET",
					`${this.baseUrl}/repos/${info.owner}/${info.repo}/pulls/${prNumber}/comments?per_page=100`,
				),
				"GitHub API error",
			),
			"failed to parse review comments",
		);
		const issueComments = parseArray<RawIssueComment>(
			this.expectOk(
				await this.client.request(
					"GET",
					`${this.baseUrl}/repos/${info.owner}/${info.repo}/issues/${prNumber}/comments?per_page=100`,
				),
				"GitHub API error",
			),
			"failed to parse issue comments",
		);
		let timelineEvents: RawTimelineEvent[] = [];
		try {
			timelineEvents = await this.fetchPrTimelineEvents(info, prNumber);
		} catch {
			// The timeline is a nice-to-have; a failure must not fail the view.
		}

		const discussions: Discussion[] = [];
		const rootById = new Map<number, Discussion>();
		for (const comment of reviewComments) {
			if (
				comment.in_reply_to_id === undefined ||
				comment.in_reply_to_id === null
			) {
				const discussion: Discussion = {
					id: String(comment.id),
					individual_note: false,
					notes: [reviewCommentNote(comment)],
				};
				discussions.push(discussion);
				rootById.set(comment.id, discussion);
			}
		}
		for (const comment of reviewComments) {
			if (
				comment.in_reply_to_id === undefined ||
				comment.in_reply_to_id === null
			)
				continue;
			const root = rootById.get(comment.in_reply_to_id);
			if (root) root.notes.push(reviewCommentNote(comment));
		}
		for (const comment of issueComments) {
			discussions.push({
				id: String(comment.id),
				individual_note: true,
				notes: [
					{
						id: comment.id,
						type: "DiscussionNote",
						body: comment.body,
						author: {
							id: 0,
							username: comment.user?.login ?? "",
							name: comment.user?.login ?? "",
							avatar_url: "",
						},
						created_at: comment.created_at,
						updated_at: comment.updated_at,
						system: false,
						resolvable: false,
						resolved: false,
					},
				],
			});
		}
		const issueCommentIds = new Set(issueComments.map((comment) => comment.id));
		for (const event of timelineEvents) {
			if (event.event === "commented" && issueCommentIds.has(event.id))
				continue;
			discussions.push({
				id: `timeline-${event.id}`,
				individual_note: true,
				notes: [
					{
						id: event.id,
						type: "TimelineEvent",
						body: timelineEventToBody(event),
						author: {
							id: 0,
							username: event.actor?.login ?? "",
							name: event.actor?.login ?? "",
							avatar_url: "",
						},
						created_at: event.created_at,
						updated_at: event.created_at,
						system: true,
						resolvable: false,
						resolved: false,
					},
				],
			});
		}
		return discussions;
	}

	/** Up to three pages of timeline events, stopping at a short page. */
	private async fetchPrTimelineEvents(
		info: GitHubRepoInfo,
		prNumber: number,
	): Promise<RawTimelineEvent[]> {
		const all: RawTimelineEvent[] = [];
		for (let page = 1; page <= 3; page++) {
			const response = await this.client.request(
				"GET",
				`${this.baseUrl}/repos/${info.owner}/${info.repo}/issues/${prNumber}/timeline?per_page=100&page=${page}`,
			);
			const body = this.expectOk(
				response,
				"GitHub API error fetching timeline",
			);
			const events = parseArray<RawTimelineEvent>(
				body,
				"failed to parse timeline events",
			);
			all.push(...events);
			if (events.length < 100) break;
		}
		return all;
	}

	// ---- CI ----

	async getPipelineJobs(info: GitHubRepoInfo, runId: number): Promise<CiJob[]> {
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/actions/runs/${runId}/jobs?per_page=100`,
		);
		const body = this.expectOk(response, "GitHub API error");
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch (error) {
			throw new Error(
				`failed to parse jobs: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const jobs = Array.isArray((parsed as { jobs?: unknown }).jobs)
			? (parsed as { jobs: RawActionJob[] }).jobs
			: [];
		return jobs.map((job) => ({
			id: job.id,
			name: job.name,
			stage: "Default",
			status: mapRunStatusToGitLab(job),
			web_url: job.html_url,
			started_at: job.started_at,
			finished_at: job.completed_at,
			...(hasDuration(job.started_at, job.completed_at)
				? { duration: durationSeconds(job.started_at, job.completed_at) }
				: {}),
			pipeline: { id: runId },
		}));
	}

	async getWorkflowRunByID(
		info: GitHubRepoInfo,
		runId: number,
	): Promise<RawWorkflowRun> {
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/actions/runs/${runId}`,
		);
		const body = this.expectOk(response, "GitHub API error");
		try {
			return JSON.parse(body) as RawWorkflowRun;
		} catch (error) {
			throw new Error(
				`failed to parse workflow run: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async getCheckRunsForRef(
		info: GitHubRepoInfo,
		ref: string,
	): Promise<RawCheckRun[]> {
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/commits/${ref}/check-runs`,
		);
		const body = this.expectOk(response, "GitHub API error");
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch (error) {
			throw new Error(
				`failed to parse check runs: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const runs = (parsed as { check_runs?: unknown }).check_runs;
		return Array.isArray(runs) ? (runs as RawCheckRun[]) : [];
	}

	/** Job logs follow a redirect to a signed URL; the redirect is not followed
	 * with the API credentials. */
	async getJobLogs(info: GitHubRepoInfo, jobId: number): Promise<string> {
		const url = `${this.baseUrl}/repos/${info.owner}/${info.repo}/actions/jobs/${jobId}/logs`;
		const response = await this.client.request("GET", url, undefined, {
			redirect: "manual",
		});
		if (response.status === 302 || response.status === 301) {
			const location = response.headers.get("Location") ?? "";
			if (location === "") throw new Error("redirect with no Location header");
			const redirected = await fetch(location);
			if (!redirected.ok)
				throw new Error(
					`failed to fetch logs from redirect: status ${redirected.status}`,
				);
			return redirected.text();
		}
		return this.expectOk(response, "GitHub API error");
	}

	async restartJob(info: GitHubRepoInfo, jobId: number): Promise<void> {
		const response = await this.client.request(
			"POST",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/actions/jobs/${jobId}/rerun`,
		);
		if (response.status !== 201)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
	}

	async cancelJob(info: GitHubRepoInfo, jobId: number): Promise<void> {
		const job = await this.getActionJob(info, jobId);
		const response = await this.client.request(
			"POST",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/actions/runs/${job.run_id}/cancel`,
		);
		if (response.status !== 202)
			throw new Error(
				`GitHub API error (status ${response.status}): ${response.body}`,
			);
	}

	private async getActionJob(
		info: GitHubRepoInfo,
		jobId: number,
	): Promise<RawActionJob> {
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/actions/jobs/${jobId}`,
		);
		const body = this.expectOk(response, "GitHub API error");
		try {
			return JSON.parse(body) as RawActionJob;
		} catch (error) {
			throw new Error(
				`failed to parse job: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async getLatestRunForSha(
		info: GitHubRepoInfo,
		sha: string,
	): Promise<RawWorkflowRun | null> {
		const response = await this.client.request(
			"GET",
			`${this.baseUrl}/repos/${info.owner}/${info.repo}/actions/runs?${sortedParams({ head_sha: sha, per_page: "1" })}`,
		);
		const body = this.expectOk(response, "GitHub API error");
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch (error) {
			throw new Error(
				`failed to parse workflow runs: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const runs = (parsed as { workflow_runs?: unknown }).workflow_runs;
		if (!Array.isArray(runs) || runs.length === 0) return null;
		return runs[0] as RawWorkflowRun;
	}

	/** Fail with the Go diagnostic when the provider answered a non-200 status. */
	private expectOk(response: GitHubResponse, prefix: string): string {
		if (response.status !== 200)
			throw new Error(
				`${prefix} (status ${response.status}): ${response.body}`,
			);
		return response.body;
	}
}

function convertPullRequest(
	pr: RawPullRequest,
	approvals: Approvals | undefined,
	latestRun: RawWorkflowRun | undefined,
): ChangeRequest {
	const { mergeStatus, detailed, hasConflicts } = mergeability(pr);
	const author = pr.user?.login ?? "";
	const changeRequest: ChangeRequest = {
		id: pr.id,
		iid: pr.number,
		title: pr.title,
		description: pr.body,
		source_branch: pr.head?.ref ?? "",
		target_branch: pr.base?.ref ?? "",
		state: prState(pr),
		web_url: pr.html_url,
		created_at: pr.created_at,
		updated_at: pr.updated_at,
		author: { name: author, username: author },
		merge_status: mergeStatus,
		detailed_merge_status: detailed,
		draft: pr.draft ?? false,
		work_in_progress: pr.draft ?? false,
		has_conflicts: hasConflicts,
		blocking_discussions_resolved: true,
		rebase_in_progress: false,
		merge_error: "",
	};
	const defaultBranch = pr.base?.repo?.default_branch ?? "";
	if (defaultBranch !== "") changeRequest.default_branch = defaultBranch;
	if (approvals) changeRequest.approvals = approvals;
	if (latestRun)
		changeRequest.head_pipeline = {
			id: latestRun.id,
			status: mapRunStatusToGitLab(latestRun),
			web_url: latestRun.html_url,
		};
	return changeRequest;
}

function reviewCommentNote(comment: RawReviewComment): Note {
	return {
		id: comment.id,
		type: "DiffNote",
		body: comment.body,
		author: {
			id: 0,
			username: comment.user?.login ?? "",
			name: comment.user?.login ?? "",
			avatar_url: "",
		},
		created_at: comment.created_at,
		updated_at: comment.updated_at,
		system: false,
		resolvable: true,
		resolved: false,
	};
}

/** Go reported a duration only when both timestamps were non-zero, so the
 * zero time the provider sends for a job that has not finished is treated as
 * absent. */
function hasDuration(startedAt: string, completedAt: string): boolean {
	return !isZeroTime(startedAt) && !isZeroTime(completedAt);
}

function isZeroTime(value: string): boolean {
	return value === "" || value.startsWith("0001-01-01");
}

function durationSeconds(startedAt: string, completedAt: string): number {
	return (Date.parse(completedAt) - Date.parse(startedAt)) / 1000;
}

/** Go marshalled these payloads from a map, so the keys are alphabetical. */
function sortedJson(entries: Readonly<Record<string, unknown>>): string {
	const ordered: Record<string, unknown> = {};
	for (const key of Object.keys(entries).sort()) ordered[key] = entries[key];
	return JSON.stringify(ordered);
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

function loginOf(user: unknown): string {
	if (typeof user === "object" && user !== null)
		return text((user as { login?: unknown }).login);
	return "";
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
