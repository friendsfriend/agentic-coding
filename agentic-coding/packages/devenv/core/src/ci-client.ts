import type { Job, TestSummary } from "@devenv/types";
import type { ClientDeps } from "./client-types";
import { handleFetchError } from "./error-handler";

export async function getPipelineJobs(
	deps: ClientDeps,
	appIdent: string,
	pipelineId: number,
	sourceType?: string,
	signal?: AbortSignal,
): Promise<Job[]> {
	const endpoint =
		sourceType === "github" ? "github/actions-jobs" : "gitlab/jobs";
	const paramName = sourceType === "github" ? "runId" : "pipelineId";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}&${paramName}=${pipelineId}`,
		{ signal },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as Job[];
}

export async function getTestSummary(
	deps: ClientDeps,
	appIdent: string,
	pipelineId: number,
	sourceType?: string,
	signal?: AbortSignal,
): Promise<TestSummary> {
	const endpoint =
		sourceType === "github"
			? "github/actions-test-summary"
			: "gitlab/test-summary";
	const paramName = sourceType === "github" ? "runId" : "pipelineId";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}&${paramName}=${pipelineId}`,
		{ signal },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as TestSummary;
}

/**
 * Get job logs for a specific job
 */
export async function getJobLogs(
	deps: ClientDeps,
	appIdent: string,
	jobId: number,
	sourceType?: string,
): Promise<string> {
	const endpoint =
		sourceType === "github" ? "github/actions-job-logs" : "gitlab/job-logs";
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/${endpoint}?appIdent=${encodeURIComponent(appIdent)}&jobId=${jobId}`,
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return await response.text();
}

export async function streamJobLogs(
	deps: ClientDeps,
	appIdent: string,
	jobId: number,
	signal: AbortSignal,
	onLine: (line: string) => void,
	onError?: (err: Error) => void,
): Promise<void> {
	try {
		const response = await deps.fetchFn(
			`${deps.baseUrl}/api/gitlab/job-logs/stream?appIdent=${encodeURIComponent(appIdent)}&jobId=${jobId}`,
			{ signal },
		);
		if (!response.ok) {
			throw new Error(`Job log stream failed: ${response.statusText}`);
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
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (line.startsWith("data: ")) {
						try {
							const parsed = JSON.parse(line.slice(6)) as {
								line?: string;
								error?: string;
							};
							if (parsed.line !== undefined) {
								onLine(parsed.line);
							}
						} catch {}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	} catch (err: unknown) {
		if (err instanceof Error && err.name === "AbortError") return;
		onError?.(err instanceof Error ? err : new Error(String(err)));
	}
}

/**
 * Retry a failed GitLab CI/CD job
 */
export async function retryJob(
	deps: ClientDeps,
	appIdent: string,
	jobId: number,
): Promise<void> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/gitlab/job-retry?appIdent=${encodeURIComponent(appIdent)}&jobId=${jobId}`,
		{ method: "POST" },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}

/**
 * Cancel a running GitLab CI/CD job
 */
export async function cancelJob(
	deps: ClientDeps,
	appIdent: string,
	jobId: number,
): Promise<void> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/gitlab/job-cancel?appIdent=${encodeURIComponent(appIdent)}&jobId=${jobId}`,
		{ method: "POST" },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}
