// Bun-served AI and session routes (`port-git-providers-and-ai-to-bun`,
// tasks 4.1-4.3), ported from `handlers_agent.go` and the log-analysis
// handlers in `handlers_github.go`.
//
// Note on methods: `routes.go` declared `GET` for the stream route while the
// handler requires `POST`; the devenv client uses `POST`. The manifest and this
// dispatcher follow the real contract.
import { readJsonBody } from "../auth.ts";
import { analyzeLogs, logAnalysisEventStream } from "./ai-streams.ts";
import { hasExecutable, queryPiSessions } from "./pi-sessions.ts";

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

/** Serve one Bun-owned AI/system route, or `undefined` for another family. */
export async function handleAiRoute(
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
