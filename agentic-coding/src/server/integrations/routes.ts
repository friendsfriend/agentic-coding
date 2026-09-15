// Legacy devenv `/api/*` surface and the Bun-served integration families.
//
// One static manifest names every legacy route family this process serves.
// There is no router framework and no per-request owner guessing: a request
// either matches a row here (and is handled in-process), matches one of the
// app-level routes, or is a 404. Rows used to carry a `bun`/`go` owner while the
// runtime was being ported; with the Go backend retired there is one runtime,
// and the manifest is the complete contract.
import { handleActionRoute } from "../actions/routes.ts";
import { readJsonBody } from "../auth.ts";
import { handleAppRoute } from "../runtime/app-routes.ts";
import {
	handleRuntimeRoute,
	type RuntimeRouteServices,
} from "../runtime/routes.ts";
import { handleAiRoute } from "./ai-routes.ts";
import { GitError, type GitRepository } from "./git-repository.ts";
import { GitHubClient } from "./github-client.ts";
import { handleGitHubRoute } from "./github-routes.ts";
import { GitLabClient } from "./gitlab-client.ts";
import { handleGitLabRoute } from "./gitlab-routes.ts";
import {
	PROVIDER_TYPE_GITHUB,
	PROVIDER_TYPE_GITLAB,
	type Provider,
	type ProviderStore,
} from "./provider-store.ts";
import type { ProviderSearchResult } from "./search-result.ts";

export type LegacyRouteOwner = "bun";

export interface LegacyRoute {
	readonly family: string;
	readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** `{param}` captures one path segment. */
	readonly path: string;
	readonly owner: LegacyRouteOwner;
}

/** Every route this process serves on the legacy surface. */
export const LEGACY_ROUTE_OWNERSHIP: readonly LegacyRoute[] = [
	// git
	{ family: "git", method: "GET", path: "/api/git/branches", owner: "bun" },
	{ family: "git", method: "GET", path: "/api/git/worktrees", owner: "bun" },
	{ family: "git", method: "POST", path: "/api/git/worktrees", owner: "bun" },
	{ family: "git", method: "PATCH", path: "/api/git/worktrees", owner: "bun" },
	{ family: "git", method: "DELETE", path: "/api/git/worktrees", owner: "bun" },
	// providers
	{ family: "providers", method: "GET", path: "/api/providers", owner: "bun" },
	{ family: "providers", method: "POST", path: "/api/providers", owner: "bun" },
	{
		family: "providers",
		method: "GET",
		path: "/api/providers/{name}",
		owner: "bun",
	},
	{
		family: "providers",
		method: "PUT",
		path: "/api/providers/{name}",
		owner: "bun",
	},
	{
		family: "providers",
		method: "DELETE",
		path: "/api/providers/{name}",
		owner: "bun",
	},
	// repos
	{ family: "repos", method: "POST", path: "/api/repos/search", owner: "bun" },
	{ family: "repos", method: "GET", path: "/api/repos/branches", owner: "bun" },
	// app (`port-environment-runtimes-to-bun`)
	{ family: "app", method: "GET", path: "/api/apps", owner: "bun" },
	{ family: "app", method: "GET", path: "/api/projects", owner: "bun" },
	{ family: "app", method: "GET", path: "/api/infra-services", owner: "bun" },
	{
		family: "app",
		method: "GET",
		path: "/api/infra-services/{ident}/logs",
		owner: "bun",
	},
	{ family: "app", method: "GET", path: "/api/status", owner: "bun" },
	{
		family: "app",
		method: "GET",
		path: "/api/apps/{ident}/docker",
		owner: "bun",
	},
	{ family: "app", method: "GET", path: "/api/apps/{ident}/git", owner: "bun" },
	{
		family: "app",
		method: "GET",
		path: "/api/apps/{ident}/profiles",
		owner: "bun",
	},
	{ family: "app", method: "POST", path: "/api/apps/create", owner: "bun" },
	{ family: "app", method: "POST", path: "/api/example-config", owner: "bun" },
	{
		family: "app",
		method: "DELETE",
		path: "/api/apps/{ident}/delete",
		owner: "bun",
	},
	// actions
	{
		family: "actions",
		method: "GET",
		path: "/api/apps/{ident}/actions",
		owner: "bun",
	},
	{
		family: "actions",
		method: "GET",
		path: "/api/action-definition",
		owner: "bun",
	},
	{
		family: "actions",
		method: "GET",
		path: "/api/action-registry/status",
		owner: "bun",
	},
	{ family: "actions", method: "POST", path: "/api/action-runs", owner: "bun" },
	{
		family: "actions",
		method: "POST",
		path: "/api/actions/cancel",
		owner: "bun",
	},
	{
		family: "actions",
		method: "GET",
		path: "/api/actions/history",
		owner: "bun",
	},
	{ family: "actions", method: "GET", path: "/api/actions/logs", owner: "bun" },
	{
		family: "actions",
		method: "POST",
		path: "/api/actions/events",
		owner: "bun",
	},
	{
		family: "actions",
		method: "GET",
		path: "/api/actions/shell-script",
		owner: "bun",
	},
	// docker / kubernetes (`port-environment-runtimes-to-bun`)
	{ family: "docker", method: "POST", path: "/api/docker/start", owner: "bun" },
	{ family: "docker", method: "POST", path: "/api/docker/stop", owner: "bun" },
	{
		family: "docker",
		method: "POST",
		path: "/api/docker/restart",
		owner: "bun",
	},
	{ family: "docker", method: "GET", path: "/api/docker/logs", owner: "bun" },
	{
		family: "docker",
		method: "GET",
		path: "/api/docker/logs/stream",
		owner: "bun",
	},
	{
		family: "docker",
		method: "GET",
		path: "/api/docker/stats/stream",
		owner: "bun",
	},
	{
		family: "kubernetes",
		method: "GET",
		path: "/api/kubernetes/logs",
		owner: "bun",
	},
	{
		family: "kubernetes",
		method: "GET",
		path: "/api/kubernetes/cluster",
		owner: "bun",
	},
	{
		family: "kubernetes",
		method: "POST",
		path: "/api/kubernetes/cluster/refresh",
		owner: "bun",
	},
	// github
	{
		family: "github",
		method: "GET",
		path: "/api/github/pull-requests",
		owner: "bun",
	},
	{
		family: "github",
		method: "GET",
		path: "/api/github/pull-request",
		owner: "bun",
	},
	{
		family: "github",
		method: "GET",
		path: "/api/github/pr-changes",
		owner: "bun",
	},
	{
		family: "github",
		method: "GET",
		path: "/api/github/pr-discussions",
		owner: "bun",
	},
	{
		family: "github",
		method: "POST",
		path: "/api/github/pr-approve",
		owner: "bun",
	},
	{
		family: "github",
		method: "POST",
		path: "/api/github/pr-unapprove",
		owner: "bun",
	},
	{
		family: "github",
		method: "POST",
		path: "/api/github/pr-toggle-approval",
		owner: "bun",
	},
	{
		family: "github",
		method: "GET",
		path: "/api/github/actions-jobs",
		owner: "bun",
	},
	{
		family: "github",
		method: "GET",
		path: "/api/github/actions-test-summary",
		owner: "bun",
	},
	{
		family: "github",
		method: "GET",
		path: "/api/github/actions-job-logs",
		owner: "bun",
	},
	{ family: "github", method: "GET", path: "/api/github/issues", owner: "bun" },
	{ family: "github", method: "GET", path: "/api/github/issue", owner: "bun" },
	{
		family: "github",
		method: "GET",
		path: "/api/github/issue-comments",
		owner: "bun",
	},
	{
		family: "github",
		method: "POST",
		path: "/api/github/issues/close",
		owner: "bun",
	},
	{
		family: "github",
		method: "POST",
		path: "/api/github/issues/reopen",
		owner: "bun",
	},
	{
		family: "github",
		method: "POST",
		path: "/api/github/issues/labels",
		owner: "bun",
	},
	{
		family: "github",
		method: "POST",
		path: "/api/github/issues/assignee",
		owner: "bun",
	},
	{
		family: "github",
		method: "POST",
		path: "/api/github/issues/unassign",
		owner: "bun",
	},
	{
		family: "github",
		method: "POST",
		path: "/api/github/issues/comment",
		owner: "bun",
	},
	{
		family: "github",
		method: "GET",
		path: "/api/github/issues/linked-crs",
		owner: "bun",
	},
	{
		family: "github",
		method: "GET",
		path: "/api/github/issues/references",
		owner: "bun",
	},
	{
		family: "github",
		method: "GET",
		path: "/api/github/cr/linked-issues",
		owner: "bun",
	},
	{ family: "github", method: "GET", path: "/api/github/labels", owner: "bun" },
	{
		family: "github",
		method: "GET",
		path: "/api/github/collaborators",
		owner: "bun",
	},
	// gitlab
	{
		family: "gitlab",
		method: "GET",
		path: "/api/gitlab/merge-requests",
		owner: "bun",
	},
	{ family: "gitlab", method: "GET", path: "/api/gitlab/jobs", owner: "bun" },
	{
		family: "gitlab",
		method: "GET",
		path: "/api/gitlab/test-summary",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "GET",
		path: "/api/gitlab/cr-changes",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "GET",
		path: "/api/gitlab/cr-versions",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/cr-comment",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "GET",
		path: "/api/gitlab/cr-discussions",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/cr-discussion-reply",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/cr-discussion-resolve",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/cr-approve",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/cr-unapprove",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/cr-toggle-approval",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/cr-rebase",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "GET",
		path: "/api/gitlab/job-logs",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/job-retry",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/job-cancel",
		owner: "bun",
	},
	{ family: "gitlab", method: "GET", path: "/api/gitlab/issues", owner: "bun" },
	{ family: "gitlab", method: "GET", path: "/api/gitlab/issue", owner: "bun" },
	{
		family: "gitlab",
		method: "GET",
		path: "/api/gitlab/issue-comments",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/issues/close",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/issues/reopen",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/issues/labels",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/issues/assignee",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/issues/unassign",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "POST",
		path: "/api/gitlab/issues/comment",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "GET",
		path: "/api/gitlab/issues/linked-crs",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "GET",
		path: "/api/gitlab/issues/references",
		owner: "bun",
	},
	{
		family: "gitlab",
		method: "GET",
		path: "/api/gitlab/cr/linked-issues",
		owner: "bun",
	},
	{ family: "gitlab", method: "GET", path: "/api/gitlab/labels", owner: "bun" },
	{
		family: "gitlab",
		method: "GET",
		path: "/api/gitlab/collaborators",
		owner: "bun",
	},
	// ai
	{ family: "ai", method: "POST", path: "/api/ai/analyze-logs", owner: "bun" },
	{
		family: "ai",
		method: "POST",
		path: "/api/ai/analyze-logs-stream",
		owner: "bun",
	},
	{
		family: "ai",
		method: "POST",
		path: "/api/ai/cr-review-stream",
		owner: "bun",
	},
	{
		family: "ai",
		method: "POST",
		path: "/api/ai/cr-comment-callback/",
		owner: "bun",
	},
	// system
	{ family: "system", method: "GET", path: "/api/pi-sessions", owner: "bun" },
	// The action view is fed by this stream, so the family that owns actions owns
	// it. `/api/health` answers in `app.ts` before this family switch runs
	// (the identity probe is public); the manifest still declares it so the
	// surface is complete in one place.
	{ family: "system", method: "GET", path: "/api/events", owner: "bun" },
	{ family: "system", method: "GET", path: "/api/health", owner: "bun" },
	// scripts
	{ family: "scripts", method: "GET", path: "/api/scripts", owner: "bun" },
	// The Go mux declares only GET, but the handler requires POST and the devenv
	// client posts here to execute a script; the manifest follows the real
	// contract, like the AI stream routes.
	{ family: "scripts", method: "POST", path: "/api/scripts", owner: "bun" },
	{
		family: "scripts",
		method: "POST",
		path: "/api/scripts/create",
		owner: "bun",
	},
	{
		family: "scripts",
		method: "POST",
		path: "/api/scripts/link",
		owner: "bun",
	},
	{
		family: "scripts",
		method: "DELETE",
		path: "/api/scripts/delete",
		owner: "bun",
	},
	{
		family: "scripts",
		method: "GET",
		path: "/api/scripts/history",
		owner: "bun",
	},
	{
		family: "scripts",
		method: "GET",
		path: "/api/scripts/metadata",
		owner: "bun",
	},
];

/** Match a request against the manifest. An unlisted path is Go-owned: the
 * delegated child answers (including its own 404). */
export function legacyRouteMatch(
	method: string,
	pathname: string,
): { route: LegacyRoute; params: Record<string, string> } | undefined {
	for (const route of LEGACY_ROUTE_OWNERSHIP) {
		if (route.method !== method) continue;
		const params = matchPath(route.path, pathname);
		if (params) return { route, params };
	}
	return undefined;
}

/** Match one manifest path, allowing the Go mux's prefix form for the trailing
 * slash route (`/api/providers/`). */
function matchPath(
	pattern: string,
	pathname: string,
): Record<string, string> | undefined {
	if (pattern.endsWith("/")) {
		if (!pathname.startsWith(pattern)) return undefined;
		const rest = pathname.slice(pattern.length);
		return rest === "" || rest.includes("/") ? undefined : { name: rest };
	}
	const patternParts = pattern.split("/");
	const pathParts = pathname.split("/");
	if (patternParts.length !== pathParts.length) return undefined;
	const params: Record<string, string> = {};
	for (let i = 0; i < patternParts.length; i++) {
		const expected = patternParts[i];
		const actual = pathParts[i];
		if (expected.startsWith("{") && expected.endsWith("}")) {
			if (actual === "") return undefined;
			params[expected.slice(1, -1)] = decodeURIComponent(actual);
			continue;
		}
		if (expected !== actual) return undefined;
	}
	return params;
}

// ---- Responses (the legacy envelope the devenv clients already parse) ----

const STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	404: "Not Found",
	405: "Method Not Allowed",
	500: "Internal Server Error",
	503: "Service Unavailable",
};

function legacyJson(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function legacyError(status: number, message: string): Response {
	return legacyJson(
		{ error: STATUS_TEXT[status] ?? "Error", message, code: status },
		status,
	);
}

// ---- Bun-served families ----

/** The app catalog the Git routes resolve an ident through. */
export interface IntegrationApps {
	getAppByIdent(ident: string): AppForGit | undefined;
	getApps(): readonly AppForGit[];
	updateAppActiveWorktree(ident: string, branch: string): void;
	loadConfig(): void;
}

export interface AppForGit {
	readonly ident: string;
	readonly repositoryPath: string;
	readonly localDirectoryPath: string;
	readonly branch: string;
	readonly activeWorktree?: string;
	readonly mainWorktreeBranch?: string;
	readonly provider?: string;
	readonly sourceType?: string;
}

export interface IntegrationServices {
	readonly providers: ProviderStore;
	readonly git: GitRepository;
	readonly apps: IntegrationApps;
	/** Injectable for fixture tests; defaults to global fetch. */
	readonly fetch?: typeof fetch;
	readonly logger?: (message: string) => void;
	/** The environment-action engine: definitions, runs, scripts and `/api/events`. */
	readonly actions?: import("../actions/routes.ts").ActionRouteContext;
	/** Container and Kubernetes capabilities (`docker`/`kubernetes` families). */
	readonly runtime?: RuntimeRouteServices;
	/** The application/infrastructure family (`app` rows). */
	readonly appFamily?: import("../runtime/app-routes.ts").AppFamilyServices;
}

/** Serve one Bun-owned legacy route, or `undefined` when the path belongs to
 * another family (the caller then delegates or 404s). */
export async function handleLegacyRoute(
	services: IntegrationServices,
	request: Request,
	url: URL,
): Promise<Response | undefined> {
	const match = legacyRouteMatch(request.method.toUpperCase(), url.pathname);
	if (match?.route.owner !== "bun") return undefined;
	switch (match.route.family) {
		case "git":
			return handleGitRoute(services, request, url, match.route.method);
		case "providers":
			return handleProviderRoute(
				services,
				request,
				match.route.method,
				match.params.name,
			);
		case "repos":
			return handleRepoRoute(services, request, url);
		case "github":
			return handleGitHubRoute(services, request, url);
		case "gitlab":
			return handleGitLabRoute(services, request, url);
		case "ai":
			return handleAiRoute(services, request, url);
		case "system": {
			if (url.pathname === "/api/events") {
				if (!services.actions) {
					return legacyError(503, "action engine is not attached");
				}
				return handleActionRoute(services.actions, request, url);
			}
			return handleAiRoute(services, request, url);
		}
		case "actions":
		case "scripts":
			if (!services.actions) {
				return legacyError(503, "action engine is not attached");
			}
			return handleActionRoute(services.actions, request, url);
		case "app": {
			if (!services.appFamily) {
				return legacyError(503, "app capability is not attached");
			}
			const handled = await handleAppRoute(services.appFamily, request, url);
			return handled ?? legacyError(404, "Not found");
		}
		case "docker":
		case "kubernetes": {
			if (!services.runtime) {
				return legacyError(503, "runtime capability is not attached");
			}
			const handled = await handleRuntimeRoute(services.runtime, request, url);
			return handled ?? legacyError(404, "Not found");
		}
		default:
			return undefined;
	}
}

async function handleGitRoute(
	services: IntegrationServices,
	request: Request,
	url: URL,
	method: string,
): Promise<Response> {
	const appIdent = url.searchParams.get("appIdent") ?? "";
	if (appIdent === "") return legacyError(400, "appIdent parameter required");
	const app = services.apps.getAppByIdent(appIdent);
	if (!app) return legacyError(404, "App not found");
	if (method === "GET" && url.pathname === "/api/git/branches")
		return gitBranches(services, app);
	if (url.pathname === "/api/git/worktrees") {
		if (method === "GET") return gitWorktrees(services, app);
		if (method === "DELETE") return removeWorktree(services, url, app);
		return updateWorktree(
			services,
			request,
			app,
			method === "POST" ? 201 : 200,
		);
	}
	return legacyError(405, "Method not allowed");
}

/** Local and remote branches plus the current branch. A repository that is not
 * cloned yet reports no local branches and carries the remote diagnostic in
 * `error`, so the branch selector still offers the remote branches. */
function gitBranches(services: IntegrationServices, app: AppForGit): Response {
	let localBranches: string[] = [];
	try {
		localBranches = services.git.getLocalBranches(app);
	} catch (error) {
		services.logger?.(
			`[WARN] failed to get local branches for ${app.ident} (repo may not be cloned yet): ${message(error)}`,
		);
	}
	let remoteBranches: string[] = [];
	let fetchError = "";
	try {
		remoteBranches = services.git.getBranches(app.repositoryPath);
	} catch (error) {
		services.logger?.(
			`[ERROR] failed to get remote branches for ${app.ident}: ${message(error)}`,
		);
		fetchError = message(error);
	}
	return legacyJson({
		appIdent: app.ident,
		currentBranch: services.git.getCurrentBranch(app),
		localBranches,
		remoteBranches,
		error: fetchError,
	});
}

function gitWorktrees(services: IntegrationServices, app: AppForGit): Response {
	const worktrees = services.git.listWorktrees(app);
	return legacyJson({ worktrees: worktrees ?? [] });
}

/** Create a linked worktree and make it active. The primary worktree cannot be
 * removed, and the active worktree is never retargeted by a removal. */
function updateWorktree(
	services: IntegrationServices,
	request: Request,
	app: AppForGit,
	status: number,
): Promise<Response> | Response {
	return readWorktreeBody(request).then((body) => {
		if (body === null)
			return legacyError(400, "appIdent and branch are required");
		if (status === 200) {
			// Switch only: the directory already exists, no Git operation runs.
			try {
				services.apps.updateAppActiveWorktree(app.ident, body.branch);
				services.apps.loadConfig();
			} catch (error) {
				return legacyError(500, message(error));
			}
			return legacyJson({
				success: true,
				appIdent: app.ident,
				branch: body.branch,
			});
		}
		try {
			services.git.addWorktree(app, body.branch);
		} catch (error) {
			return legacyError(500, message(error));
		}
		try {
			services.apps.updateAppActiveWorktree(app.ident, body.branch);
		} catch (error) {
			services.logger?.(
				`[WARN] failed to persist active worktree for ${app.ident}: ${message(error)}`,
			);
		}
		services.apps.loadConfig();
		return legacyJson(
			{ success: true, appIdent: app.ident, branch: body.branch },
			status,
		);
	});
}

async function readWorktreeBody(
	request: Request,
): Promise<{ appIdent: string; branch: string } | null> {
	let body: unknown;
	try {
		body = await readJsonBody(request, 64 * 1024);
	} catch {
		return null;
	}
	if (typeof body !== "object" || body === null) return null;
	const { appIdent, branch } = body as { appIdent?: unknown; branch?: unknown };
	if (typeof appIdent !== "string" || typeof branch !== "string") return null;
	if (appIdent === "" || branch === "") return null;
	return { appIdent, branch };
}

function removeWorktree(
	services: IntegrationServices,
	url: URL,
	app: AppForGit,
): Response {
	const branch = url.searchParams.get("branch") ?? "";
	if (branch === "")
		return legacyError(400, "appIdent and branch parameters required");
	if (branch === app.activeWorktree || branch === app.mainWorktreeBranch)
		return legacyError(400, "cannot remove the active or primary worktree");
	try {
		services.git.removeWorktree(app, branch);
	} catch (error) {
		return legacyError(500, message(error));
	}
	return legacyJson({ success: true });
}

async function handleProviderRoute(
	services: IntegrationServices,
	request: Request,
	method: string,
	name: string | undefined,
): Promise<Response> {
	if (name === undefined) {
		if (method === "GET") {
			try {
				services.providers.load();
			} catch (error) {
				return legacyError(
					500,
					`failed to reload providers: ${message(error)}`,
				);
			}
			return legacyJson(
				services.providers
					.list()
					.map(providerResponse)
					.concat(services.providers.invalidProviders().map(invalidResponse)),
			);
		}
		const provider = await readProviderBody(request);
		if (provider === null) return legacyError(400, "Invalid request body");
		try {
			services.providers.save(provider);
		} catch (error) {
			return legacyError(400, message(error));
		}
		return legacyJson({ success: true }, 201);
	}

	if (method === "GET") {
		const provider = services.providers.get(name);
		if (!provider) return legacyError(404, `Provider ${quote(name)} not found`);
		return legacyJson(providerResponse(provider));
	}
	if (method === "DELETE") {
		try {
			services.providers.delete(name);
		} catch (error) {
			return legacyError(400, message(error));
		}
		return legacyJson({ success: true });
	}
	const provider = await readProviderBody(request);
	if (provider === null) return legacyError(400, "Invalid request body");
	try {
		services.providers.save({ ...provider, name });
	} catch (error) {
		return legacyError(400, message(error));
	}
	return legacyJson({ success: true });
}

/** Provider rows never carry the token: only whether one is stored. */
function providerResponse(provider: Provider): Record<string, unknown> {
	const row: Record<string, unknown> = {
		name: provider.name,
		type: provider.type,
		username: provider.username,
		has_token: provider.token !== "",
	};
	if (provider.missingVars.length > 0) row.missing_vars = provider.missingVars;
	return row;
}

function invalidResponse(invalid: {
	name: string;
	type: string;
	reason: string;
	message: string;
}): Record<string, unknown> {
	return {
		name: invalid.name,
		type: invalid.type,
		invalid: true,
		reason: invalid.reason,
		message: invalid.message,
	};
}

async function readProviderBody(request: Request): Promise<Provider | null> {
	let body: unknown;
	try {
		body = await readJsonBody(request, 64 * 1024);
	} catch {
		return null;
	}
	if (typeof body !== "object" || body === null) return null;
	const raw = body as Record<string, unknown>;
	return {
		name: typeof raw.name === "string" ? raw.name : "",
		type: typeof raw.type === "string" ? raw.type : "",
		username: typeof raw.username === "string" ? raw.username : "",
		token: typeof raw.token === "string" ? raw.token : "",
		missingVars: [],
	};
}

/** Repository search and branch listing. GitLab search needs a host: the
 * request may supply one, otherwise the first app configured with that
 * provider (or a GitLab source type) supplies it. */
async function handleRepoRoute(
	services: IntegrationServices,
	request: Request,
	url: URL,
): Promise<Response> {
	if (url.pathname === "/api/repos/branches") {
		const repoUrl = url.searchParams.get("url") ?? "";
		if (repoUrl.trim() === "")
			return legacyError(400, "url parameter is required");
		try {
			return legacyJson({ branches: services.git.getBranches(repoUrl) });
		} catch (error) {
			return legacyError(500, message(error));
		}
	}

	let body: unknown;
	try {
		body = await readJsonBody(request, 64 * 1024);
	} catch {
		return legacyError(400, "Invalid request body");
	}
	if (typeof body !== "object" || body === null)
		return legacyError(400, "Invalid request body");
	const raw = body as Record<string, unknown>;
	const providerName = text(raw.provider).trim();
	const query = text(raw.query).trim();
	let host = text(raw.host).trim();
	if (providerName === "" || query === "")
		return legacyError(400, "provider and query are required");

	const provider = services.providers.get(providerName);
	if (!provider)
		return legacyError(404, `Provider ${quote(providerName)} not found`);

	try {
		if (provider.type === PROVIDER_TYPE_GITHUB) {
			const client = new GitHubClient({
				token: provider.token,
				username: provider.username,
				fetch: services.fetch,
			});
			return legacyJson(searchResponse(await client.search(query, 20)));
		}
		if (provider.type === PROVIDER_TYPE_GITLAB) {
			if (host === "") host = hostFromApps(services, provider.name);
			if (host === "")
				return legacyError(
					400,
					"GitLab host is required for search. Provide 'host' parameter or add an app with this provider first.",
				);
			const client = new GitLabClient({
				baseUrl: `https://${host}`,
				token: provider.token,
				username: provider.username,
				fetch: services.fetch,
			});
			return legacyJson(searchResponse(await client.searchProjects(query, 20)));
		}
		return legacyError(400, `Unsupported provider type: ${provider.type}`);
	} catch (error) {
		return legacyError(500, message(error));
	}
}

function searchResponse(results: readonly ProviderSearchResult[]): unknown[] {
	return results.map((result) => ({
		name: result.name,
		fullPath: result.fullPath,
		url: result.httpUrl,
		defaultBranch: result.defaultBranch,
	}));
}

/** First configured app whose provider (or inferred source type) is GitLab. */
function hostFromApps(
	services: IntegrationServices,
	providerName: string,
): string {
	for (const app of services.apps.getApps()) {
		if (app.repositoryPath === "") continue;
		if (
			app.provider !== providerName &&
			resolveSourceType(services, app) !== PROVIDER_TYPE_GITLAB
		)
			continue;
		const host = hostFromUrl(app.repositoryPath);
		if (host !== "") return host;
	}
	return "";
}

function resolveSourceType(
	services: IntegrationServices,
	app: AppForGit,
): string {
	if (app.provider) {
		const provider = services.providers.get(app.provider);
		if (provider?.type) return provider.type;
	}
	if (app.sourceType) return app.sourceType;
	return app.repositoryPath.toLowerCase().includes("github.com")
		? PROVIDER_TYPE_GITHUB
		: "";
}

function hostFromUrl(rawUrl: string): string {
	try {
		return new URL(rawUrl).hostname;
	} catch {
		return "";
	}
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Go's `%q` for the diagnostics the ported messages reproduce verbatim. */
function quote(value: string): string {
	return JSON.stringify(value);
}

function message(error: unknown): string {
	if (error instanceof GitError) return error.message;
	return error instanceof Error ? error.message : String(error);
}
