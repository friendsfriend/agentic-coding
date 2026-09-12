import type { ClientDeps } from "./client-types";
import { handleFetchError } from "./error-handler";

export async function analyzeLogsWithAI(
	deps: ClientDeps,
	logs: string,
	prompt?: string,
): Promise<string> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/ai/analyze-logs`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ logs, prompt: prompt ?? "" }),
	});

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	const data = (await response.json()) as { summary: string };
	return data.summary ?? "";
}

export async function* analyzeLogsWithAIStream(
	deps: ClientDeps,
	logs: string,
	prompt?: string,
	onSessionId?: (sessionId: string) => void,
): AsyncGenerator<string> {
	const body: Record<string, string> = { logs, prompt: prompt ?? "" };
	const response = await deps.sseFetchFn(
		`${deps.baseUrl}/api/ai/analyze-logs-stream`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	const reader = response.body?.getReader();
	if (!reader) throw new Error("No response body");

	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.startsWith("data: ")) continue;
				const raw = line.slice(6).trim();
				if (!raw) continue;
				let parsed: {
					delta?: string;
					done?: boolean;
					error?: string;
					sessionId?: string;
				};
				try {
					parsed = JSON.parse(raw);
				} catch {
					continue;
				}
				if (parsed.error) throw new Error(parsed.error);
				if (parsed.done) return;
				if (parsed.sessionId) {
					onSessionId?.(parsed.sessionId);
					continue;
				}
				if (parsed.delta) yield parsed.delta;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Streams an AI code review for a change request.
 * The server creates a temporary git worktree with the CR's source branch,
 * spawns pi inside that worktree so it can run `git diff` and browse files
 * autonomously, and streams the output back.
 */
export async function* analyzeCRWithAIStream(
	deps: ClientDeps,
	appIdent: string,
	crIID: number,
	sourceBranch: string,
	targetBranch: string,
	prompt: string,
): AsyncGenerator<string> {
	const body: Record<string, string | number> = {
		appIdent,
		crIID,
		sourceBranch,
		targetBranch,
		prompt,
	};

	const response = await deps.sseFetchFn(
		`${deps.baseUrl}/api/ai/cr-review-stream`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	const reader = response.body?.getReader();
	if (!reader) throw new Error("No response body");

	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.startsWith("data: ")) continue;
				const raw = line.slice(6).trim();
				if (!raw) continue;
				let parsed: { delta?: string; done?: boolean; error?: string };
				try {
					parsed = JSON.parse(raw);
				} catch {
					continue;
				}
				if (parsed.error) throw new Error(parsed.error);
				if (parsed.done) return;
				if (parsed.delta) yield parsed.delta;
			}
		}
	} finally {
		reader.releaseLock();
	}
}
