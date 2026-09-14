// Bun-served GitHub route family (`port-git-providers-and-ai-to-bun`,
// tasks 3.1-3.4), ported from `server/pkg/server/handlers_github.go` and the
// GitHub half of `handlers_issues.go`.
//
// Response envelopes, status codes and diagnostics match the Go handlers, so
// the devenv issue/CR/CI clients parse them unchanged.
import { readJsonBody } from "../auth.ts";
import { GitHubChangeRequests } from "./github-changerequest.ts";
import { extractRepoInfo, GitHubClient } from "./github-client.ts";
import { GitHubIssues } from "./github-issues.ts";
import type { AppForGit, IntegrationServices } from "./routes.ts";

const DEFAULT_PAGE = 1;
const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 100;

/** Branches that count as "the default branch" for the change-request list, so
 * a feature branch filters by source branch and a default branch does not. */
const DEFAULT_BRANCHES = new Set([
	"develop",
	"master",
	"main",
	"qa",
	"quality",
]);

interface ResolvedGitHub {
	readonly client: GitHubClient;
	readonly changeRequests: GitHubChangeRequests;
	readonly issues: GitHubIssues;
	readonly repo: { owner: string; repo: string };
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

/** App lookup shared by every route in the family. */
function appOf(
	services: IntegrationServices,
	appIdent: string,
): AppForGit | Response {
	if (appIdent === "") return fail(400, "appIdent parameter required");
	const app = services.apps.getAppByIdent(appIdent);
	if (!app) return fail(404, "App not found");
	return app;
}

/** Provider credentials for the app's configured provider. A GitHub route
 * without a token fails before any request is attempted. */
function resolveClient(
	services: IntegrationServices,
	app: AppForGit,
): ResolvedGitHub | Response {
	let repo: { owner: string; repo: string };
	try {
		repo = extractRepoInfo(app.repositoryPath);
	} catch (error) {
		return fail(
			400,
			`failed to extract repo info: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const providerName = app.provider ?? "";
	const credentials = services.providers.credentialsFor(providerName);
	if (credentials.token === "")
		return fail(400, `no token configured for provider "${providerName}"`);
	const client = new GitHubClient({
		token: credentials.token,
		username: credentials.username,
		fetch: services.fetch,
	});
	const changeRequests = new GitHubChangeRequests(client);
	return {
		client,
		changeRequests,
		issues: new GitHubIssues(client, repo, changeRequests),
		repo,
	};
}

function isResponse(value: unknown): value is Response {
	return value instanceof Response;
}

/** Serve one Bun-owned GitHub route, or `undefined` for another family. */
export async function handleGitHubRoute(
	services: IntegrationServices,
	request: Request,
	url: URL,
): Promise<Response | undefined> {
	const path = url.pathname;
	const method = request.method.toUpperCase();
	if (!path.startsWith("/api/github/")) return undefined;
	try {
		if (path === "/api/github/pull-requests" && method === "GET")
			return await pullRequests(services, request, url);
		if (path === "/api/github/pull-request" && method === "GET")
			return await pullRequest(services, url);
		if (path === "/api/github/pr-changes" && method === "GET")
			return await pullRequestChanges(services, url);
		if (path === "/api/github/pr-discussions" && method === "GET")
			return await pullRequestDiscussions(services, url);
		if (path === "/api/github/pr-approve" && method === "POST")
			return await approval(services, url, "approve");
		if (path === "/api/github/pr-unapprove" && method === "POST")
			return await approval(services, url, "unapprove");
		if (path === "/api/github/pr-toggle-approval" && method === "POST")
			return await approval(services, url, "toggle");
		if (path === "/api/github/actions-jobs" && method === "GET")
			return await actionJobs(services, url);
		if (path === "/api/github/actions-test-summary" && method === "GET")
			return await actionTestSummary(services, url);
		if (path === "/api/github/actions-job-logs" && method === "GET")
			return await actionJobLogs(services, url);
		if (
			path.startsWith("/api/github/issues") ||
			path === "/api/github/issue" ||
			path === "/api/github/issue-comments"
		)
			return await issueRoute(services, request, url, method);
		if (path === "/api/github/labels" && method === "GET")
			return await repoLabels(services, url);
		if (path === "/api/github/collaborators" && method === "GET")
			return await repoCollaborators(services, url);
		if (path === "/api/github/cr/linked-issues" && method === "GET")
			return await crLinkedIssues(services, url);
		return undefined;
	} catch (error) {
		return fail(500, error instanceof Error ? error.message : String(error));
	}
}

// ---- Issues ----

async function issueRoute(
	services: IntegrationServices,
	request: Request,
	url: URL,
	method: string,
): Promise<Response | undefined> {
	const path = url.pathname;
	if (path === "/api/github/issues" && method === "GET")
		return await listIssues(services, url);
	if (path === "/api/github/issue" && method === "GET")
		return await issueDetail(services, url);
	if (path === "/api/github/issue-comments" && method === "GET")
		return await issueComments(services, url);
	if (path === "/api/github/issues/linked-crs" && method === "GET")
		return await issueLinkedChangeRequests(services, url);
	if (path === "/api/github/issues/references" && method === "GET")
		return await issueReferences(services, url);
	if (method !== "POST") return undefined;
	if (path === "/api/github/issues/close")
		return await closeIssue(services, request, url);
	if (path === "/api/github/issues/reopen")
		return await reopenIssue(services, url);
	if (path === "/api/github/issues/labels")
		return await setLabels(services, request, url);
	if (path === "/api/github/issues/assignee")
		return await setAssignee(services, request, url);
	if (path === "/api/github/issues/unassign")
		return await unassign(services, url);
	if (path === "/api/github/issues/comment")
		return await addComment(services, request, url);
	return undefined;
}

/** `appIdent` + numeric `number`, the shared preamble of the issue routes. */
function issueTarget(
	services: IntegrationServices,
	url: URL,
): { resolved: ResolvedGitHub; number: number } | Response {
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
		const result = await resolved.issues.getIssues(undefined, {
			scope: url.searchParams.get("scope") ?? "",
			search: url.searchParams.get("search") ?? "",
			state: url.searchParams.get("state") || "open",
			sortBy: url.searchParams.get("sort") ?? "",
			sortDirection: url.searchParams.get("direction") ?? "",
			labels: splitCsv(url.searchParams.get("labels")),
			page: parsePage(url.searchParams.get("page")),
			perPage: parsePerPage(url.searchParams.get("perPage")),
		});
		return json(result);
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
				target.resolved.repo,
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
	// The reason is optional: a body that does not decode is ignored.
	const body = await readJsonOrNull(request);
	const reason =
		typeof (body as { reason?: unknown } | null)?.reason === "string"
			? ((body as { reason: string }).reason ?? "")
			: "";
	try {
		return json(
			await target.resolved.issues.closeIssue(undefined, target.number, reason),
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
	const body = await readJsonOrNull(request);
	if (!Array.isArray((body as { labels?: unknown } | null)?.labels))
		return fail(400, "Invalid request body");
	try {
		return json(
			await target.resolved.issues.setLabels(
				undefined,
				target.number,
				(body as { labels: string[] }).labels,
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
	const body = await readJsonOrNull(request);
	if (typeof (body as { assignee?: unknown } | null)?.assignee !== "string")
		return fail(400, "Invalid request body");
	try {
		return json(
			await target.resolved.issues.addAssignee(
				undefined,
				target.number,
				(body as { assignee: string }).assignee,
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
	const body = await readJsonOrNull(request);
	if (typeof (body as { body?: unknown } | null)?.body !== "string")
		return fail(400, "Invalid request body");
	try {
		return json(
			await target.resolved.issues.addComment(
				undefined,
				target.number,
				(body as { body: string }).body,
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

// ---- Change requests ----

/** `appIdent` + numeric `crIID`, the shared preamble of the CR routes. */
function crTarget(
	services: IntegrationServices,
	url: URL,
): { resolved: ResolvedGitHub; number: number; app: AppForGit } | Response {
	const appIdent = url.searchParams.get("appIdent") ?? "";
	const number = integer(url.searchParams.get("crIID"));
	if (appIdent === "" || number === undefined || number <= 0)
		return fail(400, "appIdent and crIID parameters required");
	const app = appOf(services, appIdent);
	if (isResponse(app)) return app;
	if (app.repositoryPath === "") return fail(400, "App has no repository path");
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	return { resolved, number, app };
}

async function pullRequests(
	services: IntegrationServices,
	_request: Request,
	url: URL,
): Promise<Response> {
	const appIdent = url.searchParams.get("appIdent") ?? "";
	if (appIdent === "") return fail(400, "appIdent parameter required");
	const app = appOf(services, appIdent);
	if (isResponse(app)) return app;
	if (app.repositoryPath === "") return fail(400, "App has no repository path");

	const pageParam = url.searchParams.get("page");
	const perPageParam = url.searchParams.get("perPage");
	const state = url.searchParams.get("state") || "opened";
	const allBranches = url.searchParams.get("allBranches") === "true";
	let currentBranch = services.git.getCurrentBranch(app);
	if (currentBranch === "") currentBranch = app.branch;
	const sourceBranch =
		!allBranches && !DEFAULT_BRANCHES.has(currentBranch)
			? currentBranch
			: undefined;

	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	try {
		const result = await resolved.changeRequests.getChangeRequests(
			resolved.repo,
			{
				state,
				page: parsePage(pageParam),
				perPage: parsePerPage(perPageParam),
				search: url.searchParams.get("search") ?? "",
				labels: splitCsv(url.searchParams.get("labels")),
				sortBy: url.searchParams.get("sort") ?? "",
				sortDirection: url.searchParams.get("direction") ?? "",
				// A page parameter means the caller is paging and does not need the
				// per-item detail reads.
				skipDetails: pageParam !== null || perPageParam !== null,
				sourceBranch,
			},
		);
		for (const item of result.items) {
			if (item.default_branch === undefined || item.default_branch === "")
				item.default_branch = app.mainWorktreeBranch ?? "";
		}
		if (result.items.length === 0)
			return fail(
				404,
				sourceBranch !== undefined
					? `No open pull request found for branch '${currentBranch}'`
					: "No open pull requests found for this repository",
			);
		return json(result);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch pull requests: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function pullRequest(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = crTarget(services, url);
	if (isResponse(target)) return target;
	try {
		const pr = await target.resolved.changeRequests.getPullRequest(
			target.resolved.repo,
			target.number,
		);
		if (pr.default_branch === undefined || pr.default_branch === "")
			pr.default_branch = target.app.mainWorktreeBranch ?? "";
		return json(pr);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch pull request: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function pullRequestChanges(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = crTarget(services, url);
	if (isResponse(target)) return target;
	try {
		return json(
			await target.resolved.changeRequests.getChangeRequestChanges(
				target.resolved.repo,
				target.number,
			),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch PR changes: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function pullRequestDiscussions(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = crTarget(services, url);
	if (isResponse(target)) return target;
	try {
		return json(
			await target.resolved.changeRequests.getDiscussions(
				target.resolved.repo,
				target.number,
			),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch PR discussions: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function approval(
	services: IntegrationServices,
	url: URL,
	kind: "approve" | "unapprove" | "toggle",
): Promise<Response> {
	const target = crTarget(services, url);
	if (isResponse(target)) return target;
	const messages: Record<typeof kind, [string, string]> = {
		approve: [
			"Pull request approved successfully",
			"Failed to approve pull request",
		],
		unapprove: [
			"Pull request unapproved successfully",
			"Failed to unapprove pull request",
		],
		toggle: [
			"Pull request approval toggled successfully",
			"Failed to toggle pull request approval",
		],
	};
	const [message, failure] = messages[kind];
	try {
		if (kind === "approve")
			await target.resolved.changeRequests.approve(
				target.resolved.repo,
				target.number,
			);
		else if (kind === "unapprove")
			await target.resolved.changeRequests.unapprove(
				target.resolved.repo,
				target.number,
			);
		else
			await target.resolved.changeRequests.toggleApproval(
				target.resolved.repo,
				target.number,
			);
		return json({ status: "success", message });
	} catch (error) {
		return fail(
			500,
			`${failure}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

// ---- Actions / CI ----

function ciTarget(
	services: IntegrationServices,
	url: URL,
	param: "runId" | "jobId",
): { resolved: ResolvedGitHub; id: number } | Response {
	const appIdent = url.searchParams.get("appIdent") ?? "";
	const id = integer(url.searchParams.get(param));
	if (appIdent === "" || id === undefined)
		return fail(400, `appIdent and ${param} parameters required`);
	const app = appOf(services, appIdent);
	if (isResponse(app)) return app;
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return resolved;
	return { resolved, id };
}

async function actionJobs(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = ciTarget(services, url, "runId");
	if (isResponse(target)) return target;
	try {
		return json(
			await target.resolved.changeRequests.getPipelineJobs(
				target.resolved.repo,
				target.id,
			),
		);
	} catch (error) {
		return fail(
			500,
			`Failed to fetch actions jobs: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function actionJobLogs(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const target = ciTarget(services, url, "jobId");
	if (isResponse(target)) return target;
	try {
		const logs = await target.resolved.changeRequests.getJobLogs(
			target.resolved.repo,
			target.id,
		);
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

/** Counts a test quantity out of a check-run summary. */
export function extractTestCount(text: string, pattern: RegExp): number {
	const match = pattern.exec(text);
	if (!match) return 0;
	const count = Number(match[1]);
	return Number.isInteger(count) ? count : 0;
}

const PASSED_FIRST = /(\d+)\s*passed/;
const FAILED_FIRST = /(\d+)\s*failed/;
const SKIPPED_FIRST = /(\d+)\s*skipped/;
const PASSED_SECOND = /passed[:\s]+(\d+)/;
const FAILED_SECOND = /failed[:\s]+(\d+)/;
const SKIPPED_SECOND = /skipped[:\s]+(\d+)/;
const TOTAL_TESTS = /(\d+)\s*tests?/;

/**
 * Aggregate test counts from the check-run summaries of a workflow run's head
 * commit. A missing run, missing head SHA or unreadable check runs answer with
 * an empty summary instead of an error, matching the Go handler.
 */
async function actionTestSummary(
	services: IntegrationServices,
	url: URL,
): Promise<Response> {
	const appIdent = url.searchParams.get("appIdent") ?? "";
	const runIdParam = url.searchParams.get("runId") ?? "";
	if (appIdent === "" || runIdParam === "")
		return fail(400, "appIdent and runId parameters required");
	const app = services.apps.getAppByIdent(appIdent);
	if (!app) return fail(404, `App not found: ${appIdent}`);
	const resolved = resolveClient(services, app);
	if (isResponse(resolved)) return fail(500, "failed to init client");

	const empty = {
		total: 0,
		success: 0,
		failed: 0,
		skipped: 0,
		error: 0,
		test_suites: [],
	};
	const runId = integer(runIdParam);
	if (runId === undefined) return json(empty);

	let headSha = "";
	try {
		const run = await resolved.changeRequests.getWorkflowRunByID(
			resolved.repo,
			runId,
		);
		headSha = run.head_sha ?? "";
	} catch {
		return json(empty);
	}
	if (headSha === "") return json(empty);

	let checkRuns: {
		name: string;
		status: string;
		output: { summary: string };
	}[];
	try {
		checkRuns = await resolved.changeRequests.getCheckRunsForRef(
			resolved.repo,
			headSha,
		);
	} catch {
		return json(empty);
	}

	let total = 0;
	let passed = 0;
	let failed = 0;
	let skipped = 0;
	const suites = new Map<string, { name: string; test_cases: [] }>();
	for (const checkRun of checkRuns) {
		if (checkRun.status !== "completed") continue;
		const summary = checkRun.output?.summary ?? "";
		if (summary === "") continue;
		const lower = summary.toLowerCase();
		let t = extractTestCount(lower, PASSED_FIRST);
		let f = extractTestCount(lower, FAILED_FIRST);
		let s = extractTestCount(lower, SKIPPED_FIRST);
		if (t === 0) t = extractTestCount(lower, PASSED_SECOND);
		if (f === 0) f = extractTestCount(lower, FAILED_SECOND);
		if (s === 0) s = extractTestCount(lower, SKIPPED_SECOND);
		if (t === 0 && f === 0 && s === 0) {
			const fromSummary = extractTestCount(lower, TOTAL_TESTS);
			if (fromSummary > 0) t = fromSummary;
		}
		total += t + f + s;
		passed += t;
		failed += f;
		skipped += s;
		if ((t > 0 || f > 0 || s > 0) && !suites.has(checkRun.name))
			suites.set(checkRun.name, { name: checkRun.name, test_cases: [] });
	}
	return json({
		total,
		success: passed,
		failed,
		skipped,
		error: 0,
		test_suites: [...suites.values()],
	});
}

async function readJsonOrNull(request: Request): Promise<unknown> {
	try {
		return await readJsonBody(request, 64 * 1024);
	} catch {
		return null;
	}
}
