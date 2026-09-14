// Bun-served GitLab route family (`port-git-providers-and-ai-to-bun`,
// tasks 3.5-3.8), ported from `server/pkg/server/handlers_gitlab.go` and the
// GitLab half of `handlers_issues.go`.
//
// Response envelopes, status codes and diagnostics match the Go handlers, so
// the devenv issue/CR/CI clients parse them unchanged.
import { readJsonBody } from "../auth.ts";
import { GitLabChangeRequests } from "./gitlab-changerequest.ts";
import { GitLabCi } from "./gitlab-ci.ts";
import { extractProjectInfo, GitLabClient } from "./gitlab-client.ts";
import { GitLabIssues } from "./gitlab-issues.ts";
import type { AppForGit, IntegrationServices } from "./routes.ts";

const DEFAULT_PAGE = 1;
const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 100;

const DEFAULT_BRANCHES = new Set([
	"develop",
	"master",
	"main",
	"qa",
	"quality",
]);

interface ResolvedGitLab {
	readonly client: GitLabClient;
	readonly changeRequests: GitLabChangeRequests;
	readonly issues: GitLabIssues;
	readonly ci: GitLabCi;
	readonly project: { host: string; namespace: string; project: string };
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

const STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	404: "Not Found",
	405: "Method Not Allowed",
	500: "Internal Server Error",
	503: "Service Unavailable",
};

function fail(status: number, message: string): Response {
	return json(
		{ error: STATUS_TEXT[status] ?? "Error", message, code: status },
		status,
	);
}

function parsePage(value: string | null): number {
	if (value === null || value === "") return DEFAULT_PAGE;
	const page = Number(value);
	return Number.isInteger(page) && page >= 1 ? page : DEFAULT_PAGE;
}

function parsePerPage(value: string | null): number {
	if (value === null || value === "") return DEFAULT_PER_PAGE;
	const perPage = Number(value);
	if (!Number.isInteger(perPage) || perPage < 1) return DEFAULT_PER_PAGE;
	return perPage > MAX_PER_PAGE ? MAX_PER_PAGE : perPage;
}

function splitCsv(value: string | null): string[] | undefined {
	if (value === null || value === "") return undefined;
	const parts = value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");
	return parts.length > 0 ? parts : undefined;
}

function integer(value: string | null): number | undefined {
	if (value === null || value === "") return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) ? parsed : undefined;
}

function isResponse(value: unknown): value is Response {
	return value instanceof Response;
}

function appOf(
	services: IntegrationServices,
	appIdent: string,
): AppForGit | Response {
	if (appIdent === "") return fail(400, "appIdent parameter required");
	const app = services.apps.getAppByIdent(appIdent);
	if (!app) return fail(404, "App not found");
	return app;
}

type ClientResult =
	| { readonly ok: true; readonly resolved: ResolvedGitLab }
	| { readonly ok: false; readonly status: number; readonly message: string };

/** Structured resolution, so a caller that is not a route (the review comment
 * callback) can report the same diagnostic without an HTTP envelope. */
function resolveClientResult(
	services: IntegrationServices,
	app: AppForGit,
): ClientResult {
	let project: { host: string; namespace: string; project: string };
	try {
		project = extractProjectInfo(app.repositoryPath);
	} catch (error) {
		return {
			ok: false,
			status: 400,
			message: `failed to extract project info: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	const providerName = app.provider ?? "";
	const credentials = services.providers.credentialsFor(providerName);
	if (credentials.token === "")
		return {
			ok: false,
			status: 400,
			message: `no token configured for provider "${providerName}"`,
		};
	const client = new GitLabClient({
		baseUrl: `https://${project.host}`,
		token: credentials.token,
		username: credentials.username,
		fetch: services.fetch,
	});
	return {
		ok: true,
		resolved: {
			client,
			project,
			changeRequests: new GitLabChangeRequests(client, project),
			issues: new GitLabIssues(client, project),
			ci: new GitLabCi(client, project),
		},
	};
}

function resolveClient(
	services: IntegrationServices,
	app: AppForGit,
): ResolvedGitLab | Response {
	const result = resolveClientResult(services, app);
	return result.ok ? result.resolved : fail(result.status, result.message);
}

/**
 * Resolve the GitLab target a review session needs, from an app ident alone.
 * Used by the AI comment callback, which must not trust a request-supplied
 * project: the session already decided which review it belongs to.
 */
export function gitLabReviewTarget(
	services: IntegrationServices,
	appIdent: string,
):
	| { changeRequests: GitLabChangeRequests; project: ResolvedGitLab["project"] }
	| { error: string; status: number } {
	const app = services.apps.getAppByIdent(appIdent);
	if (!app) return { error: "app not found", status: 404 };
	const result = resolveClientResult(services, app);
	if (!result.ok)
		return { error: `GitLab client error: ${result.message}`, status: 502 };
	return {
		changeRequests: result.resolved.changeRequests,
		project: result.resolved.project,
	};
}

/** Serve one Bun-owned GitLab route, or `undefined` for another family. */
export async function handleGitLabRoute(
	services: IntegrationServices,
	request: Request,
	url: URL,
): Promise<Response | undefined> {
	const path = url.pathname;
	const method = request.method.toUpperCase();
	if (!path.startsWith("/api/gitlab/")) return undefined;
	try {
		if (path === "/api/gitlab/merge-requests" && method === "GET")
			return await changeRequests(services, url);
		if (path === "/api/gitlab/jobs" && method === "GET")
			return await pipelineJobs(services, url);
		if (path === "/api/gitlab/test-summary" && method === "GET")
			return await testSummary(services, url);
		if (path === "/api/gitlab/cr-changes" && method === "GET")
			return await changeRequestChanges(services, url);
		if (path === "/api/gitlab/cr-versions" && method === "GET")
			return await changeRequestVersions(services, url);
		if (path === "/api/gitlab/cr-comment" && method === "POST")
			return await createComment(services, request);
		if (path === "/api/gitlab/cr-discussions" && method === "GET")
			return await discussions(services, url);
		if (path === "/api/gitlab/cr-discussion-reply" && method === "POST")
			return await discussionReply(services, request);
		if (path === "/api/gitlab/cr-discussion-resolve" && method === "POST")
			return await discussionResolve(services, request);
		if (path === "/api/gitlab/cr-approve" && method === "POST")
			return await approval(services, url, "approve");
		if (path === "/api/gitlab/cr-unapprove" && method === "POST")
			return await approval(services, url, "unapprove");
		if (path === "/api/gitlab/cr-toggle-approval" && method === "POST")
			return await approval(services, url, "toggle");
		if (path === "/api/gitlab/cr-rebase" && method === "POST")
			return await approval(services, url, "rebase");
		if (path === "/api/gitlab/job-logs" && method === "GET")
			return await jobLogs(services, url);
		if (path === "/api/gitlab/job-retry" && method === "POST")
			return await jobControl(services, url, "retry");
		if (path === "/api/gitlab/job-cancel" && method === "POST")
			return await jobControl(services, url, "cancel");
		if (
			path.startsWith("/api/gitlab/issues") ||
			path === "/api/gitlab/issue" ||
			path === "/api/gitlab/issue-comments" ||
			path === "/api/gitlab/cr/linked-issues"
		)
			return await issueRoute(services, request, url, method);
		if (path === "/api/gitlab/labels" && method === "GET")
			return await repoLabels(services, url);
		if (path === "/api/gitlab/collaborators" && method === "GET")
			return await repoCollaborators(services, url);
		return undefined;
	} catch (error) {
		return fail(500, error instanceof Error ? error.message : String(error));
	}
}

// ---- Change requests ----

async function changeRequests(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const appIdent = url.searchParams.get("appIdent") ?? "";
	if (appIdent === "") return fail(400, "appIdent parameter required");
	const app = appOf(services, appIdent);
	if (isResponse(app)) return app;
	if (app.repositoryPath === "") return fail(400, "App has no repository path");

	let currentBranch = services.git.getCurrentBranch(app);
	if (currentBranch === "") currentBranch = app.branch;
	const allBranches = url.searchParams.get("allBranches") === "true";
	if (!allBranches && DEFAULT_BRANCHES.has(currentBranch))
		return fail(
			400,
			`Branch '${currentBranch}' is not a feature branch. No change request to show.`,
		);

	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	const pageParam = url.searchParams.get("page");
	const perPageParam = url.searchParams.get("perPage");
	try {
		const result = await resolved.changeRequests.getChangeRequestsWithOptions({
			state: url.searchParams.get("state") || "opened",
			page: parsePage(pageParam),
			perPage: parsePerPage(perPageParam),
			search: url.searchParams.get("search") ?? "",
			labels: splitCsv(url.searchParams.get("labels")),
			sortBy: url.searchParams.get("sort") ?? "",
			sortDirection: url.searchParams.get("direction") ?? "",
			skipDetails: pageParam !== null || perPageParam !== null,
			sourceBranch: allBranches ? undefined : currentBranch,
			targetBranch: "develop",
		});
		for (const item of result.items) {
			if (item.default_branch === undefined || item.default_branch === "")
				item.default_branch = app.mainWorktreeBranch ?? "";
		}
		if (result.items.length === 0)
			return fail(
				404,
				allBranches
					? "No open change requests found for this project"
					: `No open change request found for branch '${currentBranch}' → develop`,
			);
		return json(result);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch change requests: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** `appIdent` + numeric `crIID`, shared by the merge-request routes. */
function crTarget(
	services: IntegrationServices,
	url: URL,
): { resolved: ResolvedGitLab; number: number } | Response {
	const appIdent = url.searchParams.get("appIdent") ?? "";
	const number = integer(url.searchParams.get("crIID"));
	if (appIdent === "" || number === undefined)
		return fail(400, "appIdent and crIID parameters required");
	const app = appOf(services, appIdent);
	if (isResponse(app)) return app;
	if (app.repositoryPath === "") return fail(400, "App has no repository path");
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	return { resolved, number };
}

async function changeRequestChanges(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = crTarget(services, url);
	if (isResponse(target)) return target;
	try {
		return json(
			await target.resolved.changeRequests.getChangeRequestChanges(
				target.number,
			),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch MR changes: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function changeRequestVersions(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = crTarget(services, url);
	if (isResponse(target)) return target;
	try {
		return json(
			await target.resolved.changeRequests.getMrVersions(target.number),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch MR versions: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

interface CommentRequest {
	appIdent?: unknown;
	crIID?: unknown;
	body?: unknown;
	position?: {
		base_sha?: string;
		head_sha?: string;
		start_sha?: string;
		position_type?: string;
		new_path?: string;
		old_path?: string;
		new_line?: number;
		old_line?: number;
	};
}

async function createComment(
	services: IntegrationServices,
	request: Request,
): Promise<Response> {
	const body = await readJsonOrNull<CommentRequest>(request);
	if (body === null) return fail(400, "Invalid request body: invalid JSON");
	const appIdent = typeof body.appIdent === "string" ? body.appIdent : "";
	const mrIid = typeof body.crIID === "number" ? body.crIID : 0;
	const text = typeof body.body === "string" ? body.body : "";
	if (appIdent === "" || mrIid === 0 || text === "")
		return fail(400, "appIdent, crIID, and body are required");
	const app = appOf(services, appIdent);
	if (isResponse(app)) return app;
	if (app.repositoryPath === "") return fail(400, "App has no repository path");
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	try {
		await resolved.changeRequests.createMrDiffComment(
			mrIid,
			text,
			body.position
				? {
						baseSha: body.position.base_sha ?? "",
						headSha: body.position.head_sha ?? "",
						startSha: body.position.start_sha ?? "",
						positionType: body.position.position_type ?? "",
						newPath: body.position.new_path ?? "",
						oldPath: body.position.old_path ?? "",
						newLine: body.position.new_line,
						oldLine: body.position.old_line,
					}
				: undefined,
		);
		return json({
			status: "success",
			message: "Comment created successfully",
		});
	} catch (error) {
		return fail(
			500,
			`Failed to create comment: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function discussions(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = crTarget(services, url);
	if (isResponse(target)) return target;
	try {
		return json(
			await target.resolved.changeRequests.getMrDiscussions(target.number),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch discussions: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function discussionReply(
	services: IntegrationServices,
	request: Request,
): Promise<Response> {
	const body = await readJsonOrNull<{
		appIdent?: unknown;
		crIID?: unknown;
		discussionID?: unknown;
		body?: unknown;
	}>(request);
	if (body === null) return fail(400, "Invalid request body: invalid JSON");
	const appIdent = typeof body.appIdent === "string" ? body.appIdent : "";
	const mrIid = typeof body.crIID === "number" ? body.crIID : 0;
	const discussionId =
		typeof body.discussionID === "string" ? body.discussionID : "";
	const text = typeof body.body === "string" ? body.body : "";
	if (appIdent === "" || mrIid === 0 || discussionId === "" || text === "")
		return fail(400, "appIdent, crIID, discussionID, and body are required");
	const app = appOf(services, appIdent);
	if (isResponse(app)) return app;
	if (app.repositoryPath === "") return fail(400, "App has no repository path");
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	try {
		await resolved.changeRequests.replyToDiscussion(mrIid, discussionId, text);
		return json({ status: "success", message: "Reply added successfully" });
	} catch (error) {
		return fail(
			500,
			`Failed to add reply: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function discussionResolve(
	services: IntegrationServices,
	request: Request,
): Promise<Response> {
	const body = await readJsonOrNull<{
		appIdent?: unknown;
		crIID?: unknown;
		discussionID?: unknown;
		resolved?: unknown;
	}>(request);
	if (body === null) return fail(400, "Invalid request body: invalid JSON");
	const appIdent = typeof body.appIdent === "string" ? body.appIdent : "";
	const mrIid = typeof body.crIID === "number" ? body.crIID : 0;
	const discussionId =
		typeof body.discussionID === "string" ? body.discussionID : "";
	if (appIdent === "" || mrIid === 0 || discussionId === "")
		return fail(400, "appIdent, crIID, and discussionID are required");
	const app = appOf(services, appIdent);
	if (isResponse(app)) return app;
	if (app.repositoryPath === "") return fail(400, "App has no repository path");
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	try {
		await resolved.changeRequests.resolveDiscussion(
			mrIid,
			discussionId,
			body.resolved === true,
		);
		return json({
			status: "success",
			message: "Discussion resolved successfully",
		});
	} catch (error) {
		return fail(
			500,
			`Failed to resolve discussion: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function approval(
	services: IntegrationServices,
	url: URL,
	kind: "approve" | "unapprove" | "toggle" | "rebase",
): Promise<Response> {
	const appIdent = url.searchParams.get("appIdent") ?? "";
	if (appIdent === "") return fail(400, "appIdent parameter required");
	const number = integer(url.searchParams.get("crIID"));
	if (number === undefined) return fail(400, "crIID parameter required");
	const app = appOf(services, appIdent);
	if (isResponse(app)) return app;
	if (app.repositoryPath === "") return fail(400, "App has no repository path");
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;

	const failure: Record<typeof kind, string> = {
		approve: "Failed to approve change request",
		unapprove: "Failed to unapprove change request",
		toggle: "Failed to toggle approval",
		rebase: "Failed to rebase change request",
	};
	try {
		if (kind === "toggle") {
			if (resolved.client.username === "")
				return fail(400, "GitLab username not configured");
			await resolved.changeRequests.toggleMrApproval(
				number,
				resolved.client.username,
			);
		} else if (kind === "approve")
			await resolved.changeRequests.approveChangeRequest(number);
		else if (kind === "unapprove")
			await resolved.changeRequests.unapproveChangeRequest(number);
		else await resolved.changeRequests.rebaseChangeRequest(number);
	} catch (error) {
		return fail(
			500,
			`${failure[kind]}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const message =
		kind === "approve"
			? "Merge request approved successfully"
			: kind === "unapprove"
				? "Merge request unapproved successfully"
				: kind === "toggle"
					? "Merge request approval toggled successfully"
					: "Merge request rebase triggered successfully";
	return json({ status: "success", message });
}

// ---- CI ----

function ciTarget(
	services: IntegrationServices,
	url: URL,
	param: "pipelineId" | "jobId",
): { resolved: ResolvedGitLab; id: number } | Response {
	const appIdent = url.searchParams.get("appIdent") ?? "";
	if (appIdent === "") return fail(400, "appIdent parameter required");
	const id = integer(url.searchParams.get(param));
	if (id === undefined) return fail(400, `${param} parameter required`);
	const app = appOf(services, appIdent);
	if (isResponse(app)) return app;
	if (app.repositoryPath === "") return fail(400, "App has no repository path");
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	return { resolved, id };
}

async function pipelineJobs(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = ciTarget(services, url, "pipelineId");
	if (isResponse(target)) return target;
	try {
		return json(await target.resolved.ci.getPipelineJobs(target.id));
	} catch (error) {
		return fail(
			500,
			`Failed to fetch pipeline jobs: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function testSummary(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const appIdent = url.searchParams.get("appIdent") ?? "";
	const pipelineIdParam = url.searchParams.get("pipelineId") ?? "";
	if (appIdent === "" || pipelineIdParam === "")
		return fail(400, "appIdent and pipelineId parameters required");
	const pipelineId = integer(pipelineIdParam);
	if (pipelineId === undefined) return fail(400, "Invalid pipelineId");
	const app = appOf(services, appIdent);
	if (isResponse(app)) return app;
	if (app.repositoryPath === "") return fail(400, "App has no repository path");
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	try {
		// A pipeline without a test report answers `null`, as the Go handler did.
		return json(await resolved.ci.getTestSummary(pipelineId));
	} catch (error) {
		return fail(
			500,
			`Failed to fetch test summary: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function jobLogs(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = ciTarget(services, url, "jobId");
	if (isResponse(target)) return target;
	try {
		const logs = await target.resolved.ci.getJobLogs(target.id);
		return new Response(logs, {
			status: 200,
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	} catch (error) {
		return fail(
			500,
			`Failed to fetch job logs: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function jobControl(
	services: IntegrationServices,
	url: URL,
	action: "retry" | "cancel",
): Promise<Response> {
	const target = ciTarget(services, url, "jobId");
	if (isResponse(target)) return target;
	try {
		if (action === "retry") await target.resolved.ci.restartJob(target.id);
		else await target.resolved.ci.cancelJob(target.id);
	} catch (error) {
		return fail(
			500,
			`Failed to ${action} job: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return json({ success: true, jobId: target.id, action });
}

// ---- Issues ----

async function issueRoute(
	services: IntegrationServices,
	request: Request,
	url: URL,
	method: string,
): Promise<Response | undefined> {
	const path = url.pathname;
	if (path === "/api/gitlab/issues" && method === "GET")
		return await listIssues(services, url);
	if (path === "/api/gitlab/issue" && method === "GET")
		return await issueDetail(services, url);
	if (path === "/api/gitlab/issue-comments" && method === "GET")
		return await issueComments(services, url);
	if (path === "/api/gitlab/issues/linked-crs" && method === "GET")
		return await issueLinkedChangeRequests(services, url);
	if (path === "/api/gitlab/issues/references" && method === "GET")
		return await issueReferences(services, url);
	if (path === "/api/gitlab/cr/linked-issues" && method === "GET")
		return await crLinkedIssues(services, url);
	if (method !== "POST") return undefined;
	if (path === "/api/gitlab/issues/close")
		return await closeIssue(services, request, url);
	if (path === "/api/gitlab/issues/reopen")
		return await reopenIssue(services, url);
	if (path === "/api/gitlab/issues/labels")
		return await setLabels(services, request, url);
	if (path === "/api/gitlab/issues/assignee")
		return await setAssignee(services, request, url);
	if (path === "/api/gitlab/issues/unassign")
		return await unassign(services, url);
	if (path === "/api/gitlab/issues/comment")
		return await addComment(services, request, url);
	return undefined;
}

function issueTarget(
	services: IntegrationServices,
	url: URL,
): { resolved: ResolvedGitLab; number: number } | Response {
	const appIdent = url.searchParams.get("appIdent") ?? "";
	const number = integer(url.searchParams.get("number"));
	if (appIdent === "" || number === undefined)
		return fail(400, "appIdent and number parameters required");
	const app = appOf(services, appIdent);
	if (isResponse(app)) return app;
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	return { resolved, number };
}

async function listIssues(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const appIdent = url.searchParams.get("appIdent") ?? "";
	const app = appOf(services, appIdent);
	if (isResponse(app)) return app;
	if (app.repositoryPath === "") return fail(400, "App has no repository path");
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	try {
		return json(
			await resolved.issues.getIssues(undefined, {
				scope: url.searchParams.get("scope") ?? "",
				search: url.searchParams.get("search") ?? "",
				state: url.searchParams.get("state") || "opened",
				sortBy: url.searchParams.get("sort") ?? "",
				sortDirection: url.searchParams.get("direction") ?? "",
				labels: splitCsv(url.searchParams.get("labels")),
				page: parsePage(url.searchParams.get("page")),
				perPage: parsePerPage(url.searchParams.get("perPage")),
			}),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch issues: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function issueDetail(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = issueTarget(services, url);
	if (isResponse(target)) return target;
	try {
		return json(
			await target.resolved.issues.getIssue(undefined, target.number),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch issue: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function issueComments(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = issueTarget(services, url);
	if (isResponse(target)) return target;
	try {
		return json(
			await target.resolved.issues.getIssueComments(undefined, target.number),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch issue comments: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function issueLinkedChangeRequests(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = issueTarget(services, url);
	if (isResponse(target)) return target;
	try {
		return json(
			await target.resolved.issues.getIssueLinkedChangeRequests(
				undefined,
				target.number,
			),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch linked CRs: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function issueReferences(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = issueTarget(services, url);
	if (isResponse(target)) return target;
	try {
		return json(
			await target.resolved.issues.getIssueReferencedIssues(
				undefined,
				target.number,
			),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch referenced issues: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function crLinkedIssues(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = issueTarget(services, url);
	if (isResponse(target)) return target;
	try {
		return json(
			await target.resolved.issues.getChangeRequestLinkedIssues(
				{
					owner: target.resolved.project.namespace,
					repo: target.resolved.project.project,
				},
				target.number,
			),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch linked issues: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function closeIssue(
	services: IntegrationServices,
	request: Request,
	url: URL,
): Promise<Response> {
	const target = issueTarget(services, url);
	if (isResponse(target)) return target;
	// The reason is optional and GitLab has no equivalent field; the body is
	// only read to mirror the Go handler's tolerance of a missing body.
	await readJsonOrNull(request);
	try {
		return json(
			await target.resolved.issues.closeIssue(undefined, target.number, ""),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to close issue: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function reopenIssue(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = issueTarget(services, url);
	if (isResponse(target)) return target;
	try {
		return json(
			await target.resolved.issues.reopenIssue(undefined, target.number),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to reopen issue: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function setLabels(
	services: IntegrationServices,
	request: Request,
	url: URL,
): Promise<Response> {
	const target = issueTarget(services, url);
	if (isResponse(target)) return target;
	const body = await readJsonOrNull<{ labels?: unknown }>(request);
	if (!Array.isArray(body?.labels)) return fail(400, "Invalid request body");
	try {
		return json(
			await target.resolved.issues.setLabels(
				undefined,
				target.number,
				body.labels as string[],
			),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to set labels: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function setAssignee(
	services: IntegrationServices,
	request: Request,
	url: URL,
): Promise<Response> {
	const target = issueTarget(services, url);
	if (isResponse(target)) return target;
	const body = await readJsonOrNull<{ assignee?: unknown }>(request);
	if (typeof body?.assignee !== "string")
		return fail(400, "Invalid request body");
	try {
		return json(
			await target.resolved.issues.addAssignee(
				undefined,
				target.number,
				body.assignee,
			),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to set assignee: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function unassign(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = issueTarget(services, url);
	if (isResponse(target)) return target;
	try {
		return json(
			await target.resolved.issues.removeAssignee(undefined, target.number),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to remove assignee: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function addComment(
	services: IntegrationServices,
	request: Request,
	url: URL,
): Promise<Response> {
	const target = issueTarget(services, url);
	if (isResponse(target)) return target;
	const body = await readJsonOrNull<{ body?: unknown }>(request);
	if (typeof body?.body !== "string") return fail(400, "Invalid request body");
	try {
		return json(
			await target.resolved.issues.addComment(
				undefined,
				target.number,
				body.body,
			),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to add comment: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function repoLabels(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const app = appOf(services, url.searchParams.get("appIdent") ?? "");
	if (isResponse(app)) return app;
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	try {
		return json({ labels: await resolved.issues.getRepoLabels(undefined) });
	} catch (error) {
		return fail(
			500,
			`Failed to fetch labels: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function repoCollaborators(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const app = appOf(services, url.searchParams.get("appIdent") ?? "");
	if (isResponse(app)) return app;
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	try {
		return json({
			collaborators: await resolved.issues.getRepoCollaborators(undefined),
		});
	} catch (error) {
		return fail(
			500,
			`Failed to fetch collaborators: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function readJsonOrNull<T = unknown>(
	request: Request,
): Promise<T | null> {
	try {
		return (await readJsonBody(request, 256 * 1024)) as T;
	} catch {
		return null;
	}
}
