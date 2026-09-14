// Bun-served AI and session routes (`port-git-providers-and-ai-to-bun`,
// tasks 4.1-4.5), ported from `handlers_agent.go`, `handlers_cr_ai.go` and the
// log-analysis handlers in `handlers_github.go`.
//
// Note on methods: `routes.go` declared `GET` for both stream routes while the
// handlers require `POST`; the devenv clients use `POST`. The manifest and this
// dispatcher follow the real contract.
import { readJsonBody } from "../auth.ts";
import { analyzeLogs, logAnalysisEventStream } from "./ai-streams.ts";
import {
	AI_ATTRIBUTION,
	buildCallbackInstructions,
	CrReviewSessions,
	crWorktreeAdd,
	crWorktreeRemove,
	generateReviewToken,
	type ReviewTarget,
	reviewCheckoutPath,
	reviewEventStream,
	submitReviewComment,
} from "./cr-review.ts";
import { gitLabReviewTarget } from "./gitlab-routes.ts";
import { hasExecutable, queryPiSessions } from "./pi-sessions.ts";
import type { AppForGit, IntegrationServices } from "./routes.ts";

/** Callback sessions live for the lifetime of their stream. */
export const crReviewSessions = new CrReviewSessions();

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
	422: "Unprocessable Entity",
	500: "Internal Server Error",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
};

function fail(status: number, message: string): Response {
	return json(
		{ error: STATUS_TEXT[status] ?? "Error", message, code: status },
		status,
	);
}

function sseError(message: string): Response {
	return logAnalysisEventStream(
		(async function* () {
			yield { error: message };
		})(),
	);
}

/** Serve one Bun-owned AI/system route, or `undefined` for another family. */
export async function handleAiRoute(
	services: IntegrationServices,
	request: Request,
	url: URL,
): Promise<Response | undefined> {
	const path = url.pathname;
	const method = request.method.toUpperCase();
	if (path === "/api/pi-sessions") {
		if (method !== "GET") return undefined;
		return json({ agents: queryPiSessions() });
	}
	if (!path.startsWith("/api/ai/")) return undefined;
	try {
		if (path === "/api/ai/analyze-logs" && method === "POST")
			return await analyzeLogsRoute(request);
		if (path === "/api/ai/analyze-logs-stream" && method === "POST")
			return await analyzeLogsStreamRoute(request);
		if (path === "/api/ai/cr-review-stream" && method === "POST")
			return await crReviewStreamRoute(services, request, url);
		if (path.startsWith("/api/ai/cr-comment-callback/") && method === "POST")
			return await crCommentCallbackRoute(services, request, url);
		return undefined;
	} catch (error) {
		return fail(500, error instanceof Error ? error.message : String(error));
	}
}

async function analyzeLogsRoute(request: Request): Promise<Response> {
	const body = await readJsonOrNull<{ logs?: unknown; prompt?: unknown }>(
		request,
	);
	if (body === null) return fail(400, "Invalid request body");
	const logs = typeof body.logs === "string" ? body.logs : "";
	if (logs === "") return fail(400, "logs field required");
	const prompt =
		typeof body.prompt === "string" && body.prompt !== ""
			? body.prompt
			: undefined;
	if (!hasExecutable("pi")) return fail(503, "pi not found in PATH");
	try {
		return json(
			await analyzeLogs(logs, prompt ?? defaultLogPrompt(), { hasPi: true }),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === "pi not found in PATH") return fail(503, message);
		if (message === "AI analysis timed out") return fail(504, message);
		return fail(502, message);
	}
}

async function analyzeLogsStreamRoute(request: Request): Promise<Response> {
	const body = await readJsonOrNull<{ logs?: unknown; prompt?: unknown }>(
		request,
	);
	if (body === null) return fail(400, "Invalid request body");
	const logs = typeof body.logs === "string" ? body.logs : "";
	if (logs === "") return fail(400, "logs field required");
	const prompt =
		typeof body.prompt === "string" && body.prompt !== ""
			? body.prompt
			: defaultLogPrompt();
	if (!hasExecutable("pi"))
		return new Response('{"error":"pi not found in PATH"}', {
			status: 503,
			headers: { "content-type": "application/json" },
		});
	return logAnalysisEventStream(
		(async function* () {
			try {
				const result = await analyzeLogs(logs, prompt, { hasPi: true });
				if (result.summary !== "") yield { delta: result.summary };
				yield { done: true };
			} catch (error) {
				yield {
					error: error instanceof Error ? error.message : String(error),
				};
			}
		})(),
	);
}

/** The review stream owns its checkout: it is created before the stream starts
 * and removed when the stream ends or the client disconnects. */
async function crReviewStreamRoute(
	services: IntegrationServices,
	request: Request,
	url: URL,
): Promise<Response> {
	const body = await readJsonOrNull<{
		appIdent?: unknown;
		crIID?: unknown;
		sourceBranch?: unknown;
		targetBranch?: unknown;
		prompt?: unknown;
	}>(request);
	if (body === null) return fail(400, "Invalid request body");
	const appIdent = typeof body.appIdent === "string" ? body.appIdent : "";
	if (appIdent === "") return fail(400, "appIdent field required");
	const sourceBranch =
		typeof body.sourceBranch === "string" ? body.sourceBranch : "";
	if (sourceBranch === "") return fail(400, "sourceBranch field required");
	const prompt = typeof body.prompt === "string" ? body.prompt : "";
	if (prompt === "") return fail(400, "prompt field required");
	const crIid = typeof body.crIID === "number" ? body.crIID : 0;

	const app = services.apps.getAppByIdent(appIdent);
	if (!app) return fail(404, `app not found: ${appIdent}`);
	if (app.localDirectoryPath === "")
		return fail(422, "app has no local directory path");

	const token = generateReviewToken();
	if (crIid > 0) crReviewSessions.register(token, appIdent, crIid);
	const callbackUrl = `${url.origin}/api/ai/cr-comment-callback/${token}`;
	const promptWithInstructions = `${prompt}${buildCallbackInstructions(callbackUrl, crIid > 0)}`;

	const checkoutPath = reviewCheckoutPath();
	const added = crWorktreeAdd(
		app.localDirectoryPath,
		sourceBranch,
		checkoutPath,
	);
	if (!added.ok) {
		crReviewSessions.deregister(token);
		return sseError(
			`Could not check out branch "${sourceBranch}": ${added.error}`,
		);
	}

	return reviewEventStream(
		{
			appIdent,
			crIid,
			sourceBranch,
			prompt: promptWithInstructions,
			repoDir: checkoutPath,
			callbackUrl,
		},
		{
			// Releases only this stream's own checkout and token.
			onClose: () => {
				crWorktreeRemove(app.localDirectoryPath, checkoutPath);
				crReviewSessions.deregister(token);
			},
		},
	);
}

async function crCommentCallbackRoute(
	services: IntegrationServices,
	request: Request,
	url: URL,
): Promise<Response> {
	const token = url.pathname.slice("/api/ai/cr-comment-callback/".length);
	if (token === "") return fail(400, "missing token in path");
	const session = crReviewSessions.get(token);
	if (!session) return fail(401, "unknown or expired review session token");

	const body = await readJsonOrNull<{
		file?: unknown;
		line?: unknown;
		comment?: unknown;
	}>(request);
	if (body === null) return fail(400, "invalid request body");
	const comment = typeof body.comment === "string" ? body.comment : "";
	if (comment === "") return fail(400, "comment field required");

	const outcome = await submitReviewComment(
		session,
		{
			file: typeof body.file === "string" ? body.file : "",
			line: typeof body.line === "number" ? body.line : undefined,
			comment,
		},
		(appIdent): ReviewTarget | { error: string; status: number } =>
			gitLabReviewTarget(services, appIdent),
	);
	if ("envelope" in outcome) return fail(outcome.status, outcome.envelope);
	return json(outcome.body);
}

function defaultLogPrompt(): string {
	return "Analyze these logs. Summarize errors, warnings, and any notable events concisely.";
}

async function readJsonOrNull<T = unknown>(
	request: Request,
): Promise<T | null> {
	try {
		return (await readJsonBody(request, 1024 * 1024)) as T;
	} catch {
		return null;
	}
}

export type { AppForGit };
export { AI_ATTRIBUTION };
