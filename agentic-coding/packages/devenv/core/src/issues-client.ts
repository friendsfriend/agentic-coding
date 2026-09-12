import type {
	Issue,
	IssueComment,
	IssueCommentListResult,
	IssueListResult,
	IssueScope,
} from "@devenv/types";
import type { ClientDeps } from "./client-types";
import { handleFetchError } from "./error-handler";

/**
 * Get issues for a specific app with scope filter and pagination.
 */
export async function getIssues(
	deps: ClientDeps,
	appIdent: string,
	scope: IssueScope = "all",
	sourceType?: string,
	page: number = 1,
	perPage: number = 50,
	search?: string,
	state?: string,
	sort?: string,
	direction?: "asc" | "desc",
	labels?: string[],
	signal?: AbortSignal,
): Promise<IssueListResult> {
	const params = new URLSearchParams({
		appIdent,
		scope,
	});
	// Always send state param so server knows the filter (default: "open" for GitHub, "opened" for GitLab)
	params.append(
		"state",
		state || (sourceType === "github" ? "open" : "opened"),
	);
	if (search) {
		params.append("search", search);
	}
	if (sort) params.append("sort", sort);
	if (direction) params.append("direction", direction);
	if (labels?.length) params.append("labels", labels.join(","));
	params.append("page", String(page));
	params.append("perPage", String(perPage));

	const endpoint = sourceType === "github" ? "github/issues" : "gitlab/issues";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?${params}`,
		{ signal },
	);

	if (response.status === 404 || response.status === 400) {
		return {
			items: [],
			totalCount: -1,
			totalPages: -1,
			currentPage: 1,
			perPage,
		};
	}

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as IssueListResult;
}

/**
 * Get a single issue by number.
 */
export async function getIssue(
	deps: ClientDeps,
	appIdent: string,
	number: number,
	sourceType?: string,
	signal?: AbortSignal,
): Promise<Issue> {
	const endpoint = sourceType === "github" ? "github/issue" : "gitlab/issue";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}&number=${number}`,
		{ signal },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as Issue;
}

/**
 * Get comments for a specific issue.
 */
export async function getIssueComments(
	deps: ClientDeps,
	appIdent: string,
	number: number,
	sourceType?: string,
	signal?: AbortSignal,
): Promise<IssueCommentListResult> {
	const endpoint =
		sourceType === "github" ? "github/issue-comments" : "gitlab/issue-comments";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}&number=${number}`,
		{ signal },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as IssueCommentListResult;
}

// ─── Mutation Functions ───────────────────────────────────────────────────────

async function issueMutation(
	deps: ClientDeps,
	endpoint: string,
	appIdent: string,
	number: number | undefined,
	body: unknown,
	method: string = "POST",
): Promise<Issue> {
	let url = `${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}`;
	if (number !== undefined) {
		url += `&number=${number}`;
	}

	const response = await deps.fetchFn(url, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as Issue;
}

/**
 * Close an issue with an optional reason.
 * reason: "completed" | "not_planned" | "" (empty for no reason)
 */
export async function closeIssue(
	deps: ClientDeps,
	appIdent: string,
	number: number,
	sourceType: string | undefined,
	reason?: string,
): Promise<Issue> {
	const prefix = sourceType === "github" ? "github" : "gitlab";
	return issueMutation(deps, `${prefix}/issues/close`, appIdent, number, {
		reason: reason ?? "",
	});
}

/**
 * Reopen an issue.
 */
export async function reopenIssue(
	deps: ClientDeps,
	appIdent: string,
	number: number,
	sourceType: string | undefined,
): Promise<Issue> {
	const prefix = sourceType === "github" ? "github" : "gitlab";
	return issueMutation(deps, `${prefix}/issues/reopen`, appIdent, number, {});
}

/**
 * Set labels on an issue.
 */
export async function setIssueLabels(
	deps: ClientDeps,
	appIdent: string,
	number: number,
	sourceType: string | undefined,
	labels: string[],
): Promise<Issue> {
	const prefix = sourceType === "github" ? "github" : "gitlab";
	return issueMutation(deps, `${prefix}/issues/labels`, appIdent, number, {
		labels,
	});
}

/**
 * Set assignee on an issue.
 */
export async function setIssueAssignee(
	deps: ClientDeps,
	appIdent: string,
	number: number,
	sourceType: string | undefined,
	assignee: string,
): Promise<Issue> {
	const prefix = sourceType === "github" ? "github" : "gitlab";
	return issueMutation(deps, `${prefix}/issues/assignee`, appIdent, number, {
		assignee,
	});
}

/**
 * Remove assignee from an issue.
 */
export async function removeIssueAssignee(
	deps: ClientDeps,
	appIdent: string,
	number: number,
	sourceType: string | undefined,
): Promise<Issue> {
	const prefix = sourceType === "github" ? "github" : "gitlab";
	return issueMutation(deps, `${prefix}/issues/unassign`, appIdent, number, {});
}

/**
 * Get all labels for a repository.
 */
export async function getRepoLabels(
	deps: ClientDeps,
	appIdent: string,
	sourceType: string | undefined,
): Promise<string[]> {
	const prefix = sourceType === "github" ? "github" : "gitlab";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${prefix}/labels?appIdent=${encodeURIComponent(appIdent)}`,
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	const data = (await response.json()) as { labels: string[] };
	return data.labels;
}

/**
 * Add a comment to an issue.
 */
export async function addIssueComment(
	deps: ClientDeps,
	appIdent: string,
	number: number,
	sourceType: string | undefined,
	body: string,
): Promise<IssueComment> {
	const prefix = sourceType === "github" ? "github" : "gitlab";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${prefix}/issues/comment?appIdent=${encodeURIComponent(appIdent)}&number=${number}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body }),
		},
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as IssueComment;
}

/**
 * Get linked change requests for an issue.
 */
export async function getIssueLinkedCRs(
	deps: ClientDeps,
	appIdent: string,
	number: number,
	sourceType?: string,
	signal?: AbortSignal,
): Promise<import("@devenv/types").ChangeRequest[]> {
	const endpoint =
		sourceType === "github"
			? "github/issues/linked-crs"
			: "gitlab/issues/linked-crs";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}&number=${number}`,
		{ signal },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as import("@devenv/types").ChangeRequest[];
}

/**
 * Get issues referenced in an issue's body.
 */
export async function getIssueReferencedIssues(
	deps: ClientDeps,
	appIdent: string,
	number: number,
	sourceType?: string,
	signal?: AbortSignal,
): Promise<import("@devenv/types").Issue[]> {
	const endpoint =
		sourceType === "github"
			? "github/issues/references"
			: "gitlab/issues/references";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}&number=${number}`,
		{ signal },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as import("@devenv/types").Issue[];
}

/**
 * Get linked issues for a change request.
 */
export async function getCRLinkedIssues(
	deps: ClientDeps,
	appIdent: string,
	number: number,
	sourceType?: string,
	_signal?: AbortSignal,
): Promise<import("@devenv/types").Issue[]> {
	const endpoint =
		sourceType === "github"
			? "github/cr/linked-issues"
			: "gitlab/cr/linked-issues";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}&number=${number}`,
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as import("@devenv/types").Issue[];
}

/**
 * Get all collaborators for a repository.
 */
export async function getRepoCollaborators(
	deps: ClientDeps,
	appIdent: string,
	sourceType: string | undefined,
): Promise<string[]> {
	const prefix = sourceType === "github" ? "github" : "gitlab";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${prefix}/collaborators?appIdent=${encodeURIComponent(appIdent)}`,
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	const data = (await response.json()) as { collaborators: string[] };
	return data.collaborators;
}
