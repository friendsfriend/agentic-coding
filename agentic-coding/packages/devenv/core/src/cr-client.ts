import type {
	ChangeRequest,
	ChangeRequestChange,
	ChangeRequestListResult,
	CRCommentPosition,
	CRCommentRequest,
	CRMutationResult,
	CRVersion,
	Discussion,
} from "@devenv/types";
import type { ClientDeps } from "./client-types";
import { handleFetchError } from "./error-handler";

/**
 * Get change requests for a specific app, with pagination support.
 * Returns a paginated result with items and metadata.
 */
export async function getChangeRequests(
	deps: ClientDeps,
	appIdent: string,
	state: string = "opened",
	scope: "current" | "all" = "current",
	sourceType?: string,
	page: number = 1,
	perPage: number = 50,
	search?: string,
	sort?: string,
	direction?: "asc" | "desc",
	labels?: string[],
	signal?: AbortSignal,
): Promise<ChangeRequestListResult> {
	const params = new URLSearchParams({
		appIdent,
		state,
	});
	if (scope === "all") {
		params.append("allBranches", "true");
	}
	if (search) {
		params.append("search", search);
	}
	if (sort) params.append("sort", sort);
	if (direction) params.append("direction", direction);
	if (labels?.length) params.append("labels", labels.join(","));
	params.append("page", String(page));
	params.append("perPage", String(perPage));
	const endpoint =
		sourceType === "github" ? "github/pull-requests" : "gitlab/merge-requests";
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

	return (await response.json()) as ChangeRequestListResult;
}

/**
 * Get full change request details. Used for GitHub paginated lists where
 * pipeline/approval details are intentionally skipped in list responses.
 */
export async function getChangeRequest(
	deps: ClientDeps,
	appIdent: string,
	crIID: number,
	sourceType?: string,
	signal?: AbortSignal,
): Promise<ChangeRequest> {
	if (sourceType !== "github") {
		throw new Error(
			"Full change request detail fetch is currently only implemented for GitHub",
		);
	}

	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/github/pull-request?appIdent=${encodeURIComponent(appIdent)}&crIID=${crIID}`,
		{ signal },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as ChangeRequest;
}

/**
 * Get changed files for a specific change request
 */
export async function getChangeRequestChanges(
	deps: ClientDeps,
	appIdent: string,
	crIID: number,
	sourceType?: string,
	signal?: AbortSignal,
): Promise<ChangeRequestChange[]> {
	const endpoint =
		sourceType === "github" ? "github/pr-changes" : "gitlab/cr-changes";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}&crIID=${crIID}`,
		{ signal },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as ChangeRequestChange[];
}

/**
 * Get CR versions (SHAs) for a specific change request
 */
export async function getCRVersions(
	deps: ClientDeps,
	appIdent: string,
	crIID: number,
): Promise<CRVersion[]> {
	const url = `${deps.baseUrl}/api/gitlab/cr-versions?appIdent=${encodeURIComponent(appIdent)}&crIID=${crIID}`;
	const response = await deps.fetchFn(url);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as CRVersion[];
}

/**
 * Create a comment on a change request diff
 */
export async function createCRComment(
	deps: ClientDeps,
	appIdent: string,
	crIID: number,
	body: string,
	position?: {
		baseSHA: string;
		headSHA: string;
		startSHA: string;
		positionType: string;
		newPath: string;
		oldPath: string;
		newLine?: number;
		oldLine?: number;
		lineCode?: string;
		lineRange?: CRCommentPosition["lineRange"];
	},
): Promise<CRMutationResult> {
	const payload: CRCommentRequest = {
		appIdent,
		crIID,
		body,
	};
	if (position) {
		payload.position = {
			base_sha: position.baseSHA,
			head_sha: position.headSHA,
			start_sha: position.startSHA,
			position_type: position.positionType,
			new_path: position.newPath,
			old_path: position.oldPath,
			new_line: position.newLine,
			old_line: position.oldLine,
		};

		if (position.lineCode) {
			payload.position.line_code = position.lineCode;
		}

		if (position.lineRange) {
			payload.position.line_range = {
				start: {
					type: position.lineRange.start.type,
					old_line: position.lineRange.start.oldLine,
					new_line: position.lineRange.start.newLine,
				},
				end: {
					type: position.lineRange.end.type,
					old_line: position.lineRange.end.oldLine,
					new_line: position.lineRange.end.newLine,
				},
			};
		}
	}

	const response = await deps.fetchFn(`${deps.baseUrl}/api/gitlab/cr-comment`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as CRMutationResult;
}

/**
 * Get discussions (comments) for a change request
 */
export async function getCRDiscussions(
	deps: ClientDeps,
	appIdent: string,
	crIID: number,
	sourceType?: string,
	signal?: AbortSignal,
): Promise<Discussion[]> {
	const endpoint =
		sourceType === "github" ? "github/pr-discussions" : "gitlab/cr-discussions";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}&crIID=${crIID}`,
		{ signal },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as Discussion[];
}

/**
 * Toggle change request approval (approve if not approved, unapprove if already approved)
 * Backend determines the current approval state using the configured GitLab username
 */
export async function toggleCRApproval(
	deps: ClientDeps,
	appIdent: string,
	crIID: number,
	sourceType?: string,
): Promise<void> {
	const endpoint =
		sourceType === "github"
			? "github/pr-toggle-approval"
			: "gitlab/cr-toggle-approval";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}&crIID=${crIID}`,
		{ method: "POST" },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}

/**
 * Approve a change request
 */
export async function approveChangeRequest(
	deps: ClientDeps,
	appIdent: string,
	crIID: number,
	sourceType?: string,
): Promise<void> {
	const endpoint =
		sourceType === "github" ? "github/pr-approve" : "gitlab/cr-approve";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}&crIID=${crIID}`,
		{ method: "POST" },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}

/**
 * Unapprove a change request (remove approval)
 */
export async function unapproveChangeRequest(
	deps: ClientDeps,
	appIdent: string,
	crIID: number,
	sourceType?: string,
): Promise<void> {
	const endpoint =
		sourceType === "github" ? "github/pr-unapprove" : "gitlab/cr-unapprove";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}&crIID=${crIID}`,
		{ method: "POST" },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}

/**
 * Rebase a change request
 */
export async function rebaseCR(
	deps: ClientDeps,
	appIdent: string,
	crIID: number,
): Promise<void> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/gitlab/cr-rebase?appIdent=${encodeURIComponent(appIdent)}&crIID=${crIID}`,
		{ method: "POST" },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}

/**
 * Resolve or unresolve a discussion thread
 */
export async function resolveDiscussion(
	deps: ClientDeps,
	appIdent: string,
	crIID: number,
	discussionID: string,
	resolveAction: "resolve" | "unresolve",
): Promise<{ status: string; message: string }> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/gitlab/cr-discussion-resolve`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				appIdent,
				crIID,
				discussionID,
				resolved: resolveAction === "resolve",
			}),
		},
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as { status: string; message: string };
}

/**
 * Reply to an existing discussion thread
 */
export async function replyToDiscussion(
	deps: ClientDeps,
	appIdent: string,
	crIID: number,
	discussionID: string,
	body: string,
): Promise<{ status: string; message: string }> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/gitlab/cr-discussion-reply`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				appIdent,
				crIID,
				discussionID,
				body,
			}),
		},
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as { status: string; message: string };
}
