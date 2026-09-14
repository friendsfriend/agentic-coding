// GitLab change-request capability (`port-git-providers-and-ai-to-bun`,
// tasks 3.7-3.8), ported from `server/pkg/gitlab/{merge_requests,changes,diff,
// discussions,actions}.go`.
//
// Reproduced as-is, including the parts that look surprising:
//   - GitLab line codes are `sha1("<base_sha>:<old_path>:<old_line>:<new_path>:
//     <new_line>")`, unlike GitHub's path/line form.
//   - Line stats are recomputed from the diff (excluding `---`/`+++` headers)
//     instead of trusting the provider counts, and positioned lines are only
//     parsed when the response carried a `base_sha`.
//   - The versions endpoint falls back to the merge-request detail's
//     `diff_refs` when it answers 404.
//   - `ToggleMRApproval` matches the configured username against both the
//     provider username and the display name.
import { createHash } from "node:crypto";
import type {
	ChangeRequest,
	ChangeRequestChange,
	ChangeRequestListResult,
	DiffLine,
	Discussion,
	Note,
} from "./changerequest.ts";
import {
	type GitLabClient,
	type GitLabProjectInfo,
	gitLabPagination,
	projectPath,
} from "./gitlab-client.ts";
import { goRfc3339 } from "./provider-time.ts";

export interface GitLabChangeRequestOptions {
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

interface RawMergeRequest {
	id: number;
	iid: number;
	title: string;
	description: string;
	source_branch: string;
	target_branch: string;
	state: string;
	web_url: string;
	created_at: string;
	updated_at: string;
	author?: { name: string; username: string };
	head_pipeline?: { id: number; status: string; web_url: string } | null;
	merge_status: string;
	detailed_merge_status: string;
	draft: boolean;
	work_in_progress: boolean;
	has_conflicts: boolean;
	blocking_discussions_resolved: boolean;
	rebase_in_progress: boolean;
	merge_error: string;
}

interface RawApprovals {
	approvals_required: number;
	approvals_left: number;
	approved_by: { user: { name: string; username: string } }[];
}

/** `sha1("<base_sha>:<old_path>:<old_line>:<new_path>:<new_line>")`. */
export function generateGitLabLineCode(
	baseSha: string,
	oldPath: string,
	newPath: string,
	newLine: number | null,
	oldLine: number | null,
): string {
	const content = `${baseSha}:${oldPath}:${oldLine ?? ""}:${newPath}:${newLine ?? ""}`;
	return createHash("sha1").update(content).digest("hex");
}

/** Count added and removed lines, ignoring the `---`/`+++` file headers. */
export function calculateLineStats(diff: string): {
	added: number;
	removed: number;
} {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.length === 0) continue;
		if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
	}
	return { added, removed };
}

/** Positioned diff lines for a GitLab change. Nothing is parsed without a
 * `base_sha`, because the line code cannot be formed without it. */
export function parseGitLabDiffLines(
	change: Pick<ChangeRequestChange, "diff" | "old_path" | "new_path">,
	baseSha: string,
): DiffLine[] {
	if (change.diff === "" || baseSha === "") return [];
	const lines: DiffLine[] = [];
	let currentOldLine = 0;
	let currentNewLine = 0;
	for (const line of change.diff.split("\n")) {
		if (line.length === 0) continue;
		if (line.startsWith("@@")) {
			const match = /@@ -(\d+),?\d* \+(\d+),?\d* @@/.exec(line);
			if (match) {
				currentOldLine = Number(match[1]);
				currentNewLine = Number(match[2]);
			}
			continue;
		}
		if (
			line.startsWith("---") ||
			line.startsWith("+++") ||
			line.startsWith("\\")
		)
			continue;
		const code = (newLine: number | null, oldLine: number | null) =>
			generateGitLabLineCode(
				baseSha,
				change.old_path,
				change.new_path,
				newLine,
				oldLine,
			);
		if (line.startsWith("+")) {
			const newLine = currentNewLine;
			lines.push({
				line_code: code(newLine, null),
				type: "new",
				old_line: null,
				new_line: newLine,
				text: line,
				rich_text: "",
			});
			currentNewLine += 1;
			continue;
		}
		if (line.startsWith("-")) {
			const oldLine = currentOldLine;
			lines.push({
				line_code: code(null, oldLine),
				type: "old",
				old_line: oldLine,
				new_line: null,
				text: line,
				rich_text: "",
			});
			currentOldLine += 1;
			continue;
		}
		const oldLine = currentOldLine;
		const newLine = currentNewLine;
		lines.push({
			line_code: code(newLine, oldLine),
			type: "match",
			old_line: oldLine,
			new_line: newLine,
			text: line,
			rich_text: "",
		});
		currentOldLine += 1;
		currentNewLine += 1;
	}
	return lines;
}

function normalizeMrSort(sortBy: string): string {
	switch (sortBy) {
		case "created":
		case "created_at":
			return "created_at";
		case "updated":
		case "updated_at":
			return "updated_at";
		case "title":
			return "title";
		default:
			return "updated_at";
	}
}

/** Sorted query string, matching Go's `url.Values.Encode()`. */
function sortedParams(entries: Readonly<Record<string, string>>): string {
	const params = new URLSearchParams();
	for (const key of Object.keys(entries).sort()) params.set(key, entries[key]);
	return params.toString();
}

export class GitLabChangeRequests {
	private readonly client: GitLabClient;
	private readonly project: GitLabProjectInfo;

	constructor(client: GitLabClient, project: GitLabProjectInfo) {
		this.client = client;
		this.project = project;
	}

	private get base(): string {
		return `${this.client.baseUrl}/api/v4/projects/${projectPath(this.project)}`;
	}

	/** Merge requests for a source/target branch pair, with per-MR detail. */
	async getChangeRequests(
		sourceBranch: string,
		targetBranch: string,
	): Promise<ChangeRequest[]> {
		const params: Record<string, string> = {
			state: "opened",
			per_page: "100",
			with_merge_status_recheck: "true",
		};
		if (sourceBranch !== "") params.source_branch = sourceBranch;
		if (targetBranch !== "") params.target_branch = targetBranch;
		const response = await this.client.request(
			`${this.base}/merge_requests?${sortedParams(params)}`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitLab API request failed with status ${response.status}: ${response.body}`,
			);
		const mergeRequests = parseArray<RawMergeRequest>(
			response.body,
			"failed to parse JSON response",
		);
		const detailed: ChangeRequest[] = [];
		for (const mergeRequest of mergeRequests) {
			try {
				detailed.push(await this.getChangeRequest(mergeRequest.iid));
			} catch {
				// A failed detail read keeps the list entry, as in Go.
				detailed.push(convertMergeRequest(mergeRequest));
			}
		}
		return detailed;
	}

	/** Merge requests with pagination and filter options. */
	async getChangeRequestsWithOptions(
		options: GitLabChangeRequestOptions = {},
	): Promise<ChangeRequestListResult> {
		const state =
			options.state !== undefined && options.state !== ""
				? options.state
				: "opened";
		const page = options.page && options.page > 0 ? options.page : 1;
		const perPage =
			options.perPage && options.perPage > 0 ? options.perPage : 50;
		const params: Record<string, string> = {};
		if (options.sourceBranch) params.source_branch = options.sourceBranch;
		if (options.targetBranch) params.target_branch = options.targetBranch;
		if (options.search) params.search = options.search;
		if (options.labels && options.labels.length > 0)
			params.labels = options.labels.join(",");
		if (options.sortBy) params.order_by = normalizeMrSort(options.sortBy);
		if (options.sortDirection === "asc" || options.sortDirection === "desc")
			params.sort = options.sortDirection;
		if (params.order_by === undefined) params.order_by = "updated_at";
		if (params.sort === undefined) params.sort = "desc";
		params.state = state;
		params.page = String(page);
		params.per_page = String(perPage);
		params.with_merge_status_recheck = "true";

		const response = await this.client.request(
			`${this.base}/merge_requests?${sortedParams(params)}`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitLab API request failed with status ${response.status}: ${response.body}`,
			);
		const pagination = gitLabPagination(response.headers, page);
		const mergeRequests = parseArray<RawMergeRequest>(
			response.body,
			"failed to parse JSON response",
		);
		const items: ChangeRequest[] = [];
		for (const mergeRequest of mergeRequests) {
			if (options.skipDetails) {
				items.push(convertMergeRequest(mergeRequest));
				continue;
			}
			try {
				items.push(await this.getChangeRequest(mergeRequest.iid));
			} catch {
				items.push(convertMergeRequest(mergeRequest));
			}
		}
		return {
			items,
			totalCount: pagination.totalCount,
			totalPages: pagination.totalPages,
			currentPage: pagination.currentPage,
			perPage,
		};
	}

	/** One merge request with its approval information. A failed approval read
	 * leaves the merge request without approvals instead of failing. */
	async getChangeRequest(mrIid: number): Promise<ChangeRequest> {
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitLab API request failed with status ${response.status}: ${response.body}`,
			);
		const mergeRequest = parseObject<RawMergeRequest>(
			response.body,
			"failed to parse JSON response",
		);
		const result = convertMergeRequest(mergeRequest);
		try {
			const approvals = await this.getMergeRequestApprovals(mrIid);
			if (approvals) result.approvals = approvals;
		} catch {
			// Approvals are optional (GitLab CE has no approvals endpoint).
		}
		return result;
	}

	async getMergeRequestApprovals(
		mrIid: number,
	): Promise<RawApprovals | undefined> {
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}/approvals`,
		);
		if (response.status !== 200)
			throw new Error(`approvals endpoint returned status ${response.status}`);
		return parseObject<RawApprovals>(
			response.body,
			"failed to parse JSON response",
		);
	}

	async getChangeRequestChanges(mrIid: number): Promise<ChangeRequestChange[]> {
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}/changes`,
		);
		switch (response.status) {
			case 200:
				break;
			case 404:
				throw new Error("change request not found");
			case 401:
				throw new Error("GitLab authentication failed - check your token");
			case 403:
				throw new Error(
					"access forbidden - you may not have permission to view this change request",
				);
			default:
				throw new Error(
					`GitLab API request failed with status ${response.status}: ${response.body}`,
				);
		}
		let parsed: {
			changes?: (RawMergeRequest & Partial<ChangeRequestChange>)[];
			diff_refs?: { base_sha?: string };
		};
		try {
			parsed = JSON.parse(response.body);
		} catch (error) {
			throw new Error(
				`failed to parse response: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const baseSha = parsed.diff_refs?.base_sha ?? "";
		return (parsed.changes ?? []).map((raw) => {
			const change: ChangeRequestChange = {
				old_path: raw.old_path ?? "",
				new_path: raw.new_path ?? "",
				a_mode: raw.a_mode ?? "",
				b_mode: raw.b_mode ?? "",
				new_file: raw.new_file ?? false,
				renamed_file: raw.renamed_file ?? false,
				deleted_file: raw.deleted_file ?? false,
				diff: raw.diff ?? "",
				lines_added: 0,
				lines_deleted: 0,
			};
			const stats = calculateLineStats(change.diff);
			change.lines_added = stats.added;
			change.lines_deleted = stats.removed;
			const diffLines = parseGitLabDiffLines(change, baseSha);
			if (diffLines.length > 0) change.diff_lines = diffLines;
			return change;
		});
	}

	/** Diff versions, falling back to the merge request's `diff_refs` when the
	 * versions endpoint is unavailable. */
	async getMrVersions(mrIid: number): Promise<Record<string, unknown>[]> {
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}/versions`,
		);
		switch (response.status) {
			case 200:
				return parseArray<Record<string, unknown>>(
					response.body,
					"failed to parse response",
				);
			case 404:
				return this.versionsFromDetails(mrIid);
			case 401:
				throw new Error("GitLab authentication failed - check your token");
			case 403:
				throw new Error(
					"access forbidden - you may not have permission to view this change request",
				);
			default:
				throw new Error(
					`GitLab API request failed with status ${response.status}: ${response.body}`,
				);
		}
	}

	private async versionsFromDetails(
		mrIid: number,
	): Promise<Record<string, unknown>[]> {
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}`,
		);
		if (response.status !== 200)
			throw new Error(
				`failed to fetch MR details (status ${response.status}): ${response.body}`,
			);
		let detail: { diff_refs?: Record<string, unknown> };
		try {
			detail = JSON.parse(response.body);
		} catch (error) {
			throw new Error(
				`failed to parse MR details: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const diffRefs = detail.diff_refs;
		if (!diffRefs) throw new Error("diff_refs not found in MR details");
		return [
			{
				base_commit_sha: text(diffRefs.base_sha),
				head_commit_sha: text(diffRefs.head_sha),
				start_commit_sha: text(diffRefs.start_sha),
			},
		];
	}

	// ---- Discussions ----

	async getMrDiscussions(mrIid: number): Promise<Discussion[]> {
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}/discussions`,
		);
		if (response.status !== 200)
			throw new Error(
				`GitLab API request failed with status ${response.status}: ${response.body}`,
			);
		// The route returns the provider discussion as-is, so a diff position and
		// the resolution metadata survive to the client; only the timestamp
		// rendering is normalized.
		return parseArray<Discussion>(
			response.body,
			"failed to unmarshal discussions",
		).map((discussion) => ({
			...discussion,
			notes: (discussion.notes ?? []).map((note) => ({
				...note,
				created_at: goRfc3339(note.created_at),
				updated_at: goRfc3339(note.updated_at),
				...(note.resolved_at
					? { resolved_at: goRfc3339(note.resolved_at) }
					: {}),
			})),
		}));
	}

	async createMrDiffComment(
		mrIid: number,
		body: string,
		position:
			| {
					baseSha: string;
					headSha: string;
					startSha: string;
					positionType: string;
					newPath: string;
					oldPath: string;
					newLine?: number;
					oldLine?: number;
			  }
			| undefined,
	): Promise<void> {
		const payload: Record<string, unknown> = { body };
		if (position) {
			const pos: Record<string, unknown> = {
				base_sha: position.baseSha,
				head_sha: position.headSha,
				start_sha: position.startSha,
				position_type: position.positionType,
				new_path: position.newPath,
				old_path: position.oldPath,
			};
			if (position.newLine !== undefined) pos.new_line = position.newLine;
			if (position.oldLine !== undefined) pos.old_line = position.oldLine;
			// The nested position was a Go map, so its keys are alphabetical too.
			payload.position = sortKeys(pos);
		}
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}/discussions`,
			{
				method: "POST",
				body: sortedJson(payload),
				contentType: "application/json",
			},
		);
		switch (response.status) {
			case 201:
				return;
			case 404:
				throw new Error("change request not found");
			case 401:
				throw new Error("GitLab authentication failed - check your token");
			case 403:
				throw new Error(
					"access forbidden - you may not have permission to comment on this change request",
				);
			case 400:
				throw new Error(`cannot create comment: ${response.body}`);
			default:
				throw new Error(
					`GitLab API request failed with status ${response.status}: ${response.body}`,
				);
		}
	}

	async replyToDiscussion(
		mrIid: number,
		discussionId: string,
		body: string,
	): Promise<void> {
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}/discussions/${discussionId}/notes`,
			{
				method: "POST",
				body: sortedJson({ body }),
				contentType: "application/json",
			},
		);
		if (response.status !== 201 && response.status !== 200)
			throw new Error(
				`GitLab API request failed with status ${response.status}: ${response.body}`,
			);
	}

	async resolveDiscussion(
		mrIid: number,
		discussionId: string,
		resolved: boolean,
	): Promise<void> {
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}/discussions/${discussionId}`,
			{
				method: "PUT",
				body: sortedJson({ resolved }),
				contentType: "application/json",
			},
		);
		if (response.status !== 200)
			throw new Error(
				`GitLab API request failed with status ${response.status}: ${response.body}`,
			);
	}

	// ---- Approvals and lifecycle ----

	async approveChangeRequest(mrIid: number): Promise<void> {
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}/approve`,
			{ method: "POST" },
		);
		expectApprovalStatus(response, "approve");
	}

	async unapproveChangeRequest(mrIid: number): Promise<void> {
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}/unapprove`,
			{ method: "POST" },
		);
		expectApprovalStatus(response, "unapprove");
	}

	/** Approve when the configured user has not approved yet, otherwise remove
	 * the approval. The configured username is matched against the provider
	 * username and the display name, as the Go client did. */
	async toggleMrApproval(
		mrIid: number,
		currentUsername: string,
	): Promise<void> {
		const mergeRequest = await this.getChangeRequest(mrIid);
		const alreadyApproved = (mergeRequest.approvals?.approved_by ?? []).some(
			(entry) =>
				entry.user.username === currentUsername ||
				entry.user.name === currentUsername,
		);
		if (alreadyApproved) return this.unapproveChangeRequest(mrIid);
		return this.approveChangeRequest(mrIid);
	}

	async rebaseChangeRequest(mrIid: number): Promise<void> {
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}/rebase`,
			{ method: "PUT" },
		);
		switch (response.status) {
			case 200:
			case 202:
				return;
			case 404:
				throw new Error("change request not found");
			case 401:
				throw new Error("GitLab authentication failed - check your token");
			case 403:
				throw new Error(
					"access forbidden - you may not have permission to rebase this change request",
				);
			case 400:
				throw new Error(`cannot rebase change request: ${response.body}`);
			case 409:
				throw new Error("rebase already in progress");
			default:
				throw new Error(
					`GitLab API request failed with status ${response.status}: ${response.body}`,
				);
		}
	}

	async closeChangeRequest(mrIid: number): Promise<void> {
		const response = await this.client.request(
			`${this.base}/merge_requests/${mrIid}`,
			{
				method: "PUT",
				body: "state_event=close",
				contentType: "application/x-www-form-urlencoded",
			},
		);
		switch (response.status) {
			case 200:
				return;
			case 404:
				throw new Error("change request not found");
			case 401:
				throw new Error("GitLab authentication failed - check your token");
			case 403:
				throw new Error(
					"access forbidden - you may not have permission to close this change request",
				);
			case 400:
				throw new Error(`cannot close change request: ${response.body}`);
			default:
				throw new Error(
					`GitLab API request failed with status ${response.status}: ${response.body}`,
				);
		}
	}
}

function expectApprovalStatus(
	response: { status: number; body: string },
	action: "approve" | "unapprove",
): void {
	switch (response.status) {
		case 200:
		case 201:
			return;
		case 404:
			throw new Error("change request not found");
		case 401:
			throw new Error("GitLab authentication failed - check your token");
		case 403:
			throw new Error(
				`access forbidden - you may not have permission to ${action} this change request`,
			);
		case 409:
		case 400:
			throw new Error(`cannot ${action} change request: ${response.body}`);
		default:
			throw new Error(
				`GitLab API request failed with status ${response.status}: ${response.body}`,
			);
	}
}

/** Convert a GitLab merge request to the canonical change-request shape. */
export function convertMergeRequest(mr: RawMergeRequest): ChangeRequest {
	const changeRequest: ChangeRequest = {
		id: mr.id,
		iid: mr.iid,
		title: mr.title,
		description: mr.description,
		source_branch: mr.source_branch,
		target_branch: mr.target_branch,
		state: mr.state,
		web_url: mr.web_url,
		created_at: goRfc3339(mr.created_at),
		updated_at: goRfc3339(mr.updated_at),
		author: {
			name: mr.author?.name ?? "",
			username: mr.author?.username ?? "",
		},
		merge_status: mr.merge_status,
		detailed_merge_status: mr.detailed_merge_status,
		draft: mr.draft,
		work_in_progress: mr.work_in_progress,
		has_conflicts: mr.has_conflicts,
		blocking_discussions_resolved: mr.blocking_discussions_resolved,
		rebase_in_progress: mr.rebase_in_progress,
		merge_error: mr.merge_error,
	};
	if (mr.head_pipeline)
		changeRequest.head_pipeline = {
			id: mr.head_pipeline.id,
			status: mr.head_pipeline.status,
			web_url: mr.head_pipeline.web_url,
		};
	return changeRequest;
}

/** Attach approval information to a converted change request. */
export function withApprovals(
	changeRequest: ChangeRequest,
	approvals: RawApprovals | undefined,
): ChangeRequest {
	if (approvals) changeRequest.approvals = approvals;
	return changeRequest;
}

/** Go marshalled these payloads from a map, so the keys are alphabetical. */
function sortedJson(entries: Readonly<Record<string, unknown>>): string {
	return JSON.stringify(sortKeys(entries));
}

function sortKeys(
	entries: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const ordered: Record<string, unknown> = {};
	for (const key of Object.keys(entries).sort()) ordered[key] = entries[key];
	return ordered;
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

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export type { Discussion, Note };
