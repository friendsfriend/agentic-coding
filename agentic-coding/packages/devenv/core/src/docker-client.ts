import type {
	ActionTarget,
	AppAction,
	ContainerStats,
	KubernetesClusterStatus,
	ShellActionScriptRequest,
	ShellActionScriptResponse,
} from "@devenv/types";
import type { ClientDeps } from "./client-types";
import { handleFetchError } from "./error-handler";

export async function getActionTargets(
	deps: ClientDeps,
	appIdent: string,
	action: AppAction,
): Promise<ActionTarget[]> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/apps/${encodeURIComponent(appIdent)}/actions/${encodeURIComponent(action)}/targets`,
		{ method: "GET" },
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
		return [];
	}

	const data = (await response.json()) as { targets: ActionTarget[] };
	return data.targets;
}

/**
 * Start an app using docker compose (creates/starts containers)
 * This is the preferred method for starting apps that may not have running containers
 */
export async function createShellActionScript(
	deps: ClientDeps,
	request: ShellActionScriptRequest,
): Promise<ShellActionScriptResponse> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/actions/shell-script`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
		},
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as ShellActionScriptResponse;
}

export interface StartAppResponse {
	missingEnvVars?: string[];
}

export async function startApp(
	deps: ClientDeps,
	appIdent: string,
	profile: string = "",
	targetId?: string,
): Promise<StartAppResponse> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 60000);

	try {
		const response = await deps.fetchFn(`${deps.baseUrl}/api/actions/start`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ ident: appIdent, profile, targetId }),
			signal: controller.signal,
		});
		clearTimeout(timeoutId);

		if (!response.ok) {
			await handleFetchError(response, deps.onError);
		}

		const data = await response.json();
		return { missingEnvVars: data.missingEnvVars };
	} catch (error) {
		clearTimeout(timeoutId);
		if (error instanceof Error && error.name === "AbortError") {
			const timeoutError = new Error(
				"App start operation timed out after 60 seconds",
			);
			if (deps.onError) {
				deps.onError("Timeout Error", timeoutError.message);
			}
			throw timeoutError;
		}
		throw error;
	}
}

export async function testApp(
	deps: ClientDeps,
	appIdent: string,
	targetId?: string,
	profile?: string,
	targetLabel?: string,
): Promise<void> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 60000);

	try {
		const response = await deps.fetchFn(`${deps.baseUrl}/api/actions/test`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ ident: appIdent, targetId, profile, targetLabel }),
			signal: controller.signal,
		});
		clearTimeout(timeoutId);

		if (!response.ok) {
			await handleFetchError(response, deps.onError);
		}
	} catch (error) {
		clearTimeout(timeoutId);
		if (error instanceof Error && error.name === "AbortError") {
			const timeoutError = new Error(
				"App test operation timed out after 60 seconds",
			);
			if (deps.onError) {
				deps.onError("Timeout Error", timeoutError.message);
			}
			throw timeoutError;
		}
		throw error;
	}
}

export async function stopApp(
	deps: ClientDeps,
	appIdent: string,
	targetId?: string,
): Promise<void> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/actions/stop`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ident: appIdent, targetId }),
	});
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}

export async function getKubernetesLogs(
	deps: ClientDeps,
	appIdent: string,
): Promise<string> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/kubernetes/logs?appIdent=${encodeURIComponent(appIdent)}`,
	);
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
	return response.text();
}

export async function getKubernetesClusterStatus(
	deps: ClientDeps,
): Promise<KubernetesClusterStatus> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/kubernetes/cluster`,
		{ method: "GET" },
	);
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
	return (await response.json()) as KubernetesClusterStatus;
}

async function invokeKubernetesClusterAction(
	deps: ClientDeps,
	path: string,
): Promise<KubernetesClusterStatus | undefined> {
	const response = await deps.fetchFn(`${deps.baseUrl}${path}`, {
		method: "POST",
	});
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
	const data = (await response.json()) as unknown;
	if (data && typeof data === "object" && "data" in data) {
		return (data as { data?: KubernetesClusterStatus }).data;
	}
	return data as KubernetesClusterStatus;
}

export async function createKubernetesCluster(
	deps: ClientDeps,
): Promise<KubernetesClusterStatus | undefined> {
	return invokeKubernetesClusterAction(deps, "/api/kubernetes/cluster/create");
}

export async function deleteKubernetesCluster(
	deps: ClientDeps,
): Promise<KubernetesClusterStatus | undefined> {
	return invokeKubernetesClusterAction(deps, "/api/kubernetes/cluster/delete");
}

export async function recreateKubernetesCluster(
	deps: ClientDeps,
): Promise<KubernetesClusterStatus | undefined> {
	return invokeKubernetesClusterAction(
		deps,
		"/api/kubernetes/cluster/recreate",
	);
}

export async function exportKubernetesKubeconfig(
	deps: ClientDeps,
): Promise<void> {
	await invokeKubernetesClusterAction(
		deps,
		"/api/kubernetes/cluster/export-kubeconfig",
	);
}

export async function refreshKubernetesCluster(
	deps: ClientDeps,
): Promise<KubernetesClusterStatus> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/kubernetes/cluster/refresh`,
		{ method: "POST" },
	);
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
	return (await response.json()) as KubernetesClusterStatus;
}

export async function runApp(
	deps: ClientDeps,
	appIdent: string,
	profile: string = "",
	targetId?: string,
	targetLabel?: string,
): Promise<void> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 60000);

	try {
		const response = await deps.fetchFn(`${deps.baseUrl}/api/actions/run`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ ident: appIdent, profile, targetId, targetLabel }),
			signal: controller.signal,
		});
		clearTimeout(timeoutId);

		if (!response.ok) {
			await handleFetchError(response, deps.onError);
		}
	} catch (error) {
		clearTimeout(timeoutId);
		if (error instanceof Error && error.name === "AbortError") {
			const timeoutError = new Error(
				"App run operation timed out after 60 seconds",
			);
			if (deps.onError) {
				deps.onError("Timeout Error", timeoutError.message);
			}
			throw timeoutError;
		}
		throw error;
	}
}

/**
 * Trigger build operation for an app
 */
export async function cancelAction(
	deps: ClientDeps,
	appIdent: string,
): Promise<void> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/actions/cancel`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ident: appIdent }),
	});
	if (!response.ok) await handleFetchError(response, deps.onError);
}

export async function buildApp(
	deps: ClientDeps,
	appIdent: string,
	targetId?: string,
	profile?: string,
	targetLabel?: string,
): Promise<void> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/actions/build`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ ident: appIdent, targetId, profile, targetLabel }),
	});

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}

/**
 * Start a Docker container by containerID (for already-created containers)
 * For starting apps that don't have containers yet, use startApp() instead
 */
export async function startContainer(
	deps: ClientDeps,
	containerID: string,
): Promise<void> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 10000);

	try {
		const response = await deps.fetchFn(
			`${deps.baseUrl}/api/docker/start?containerID=${encodeURIComponent(containerID)}`,
			{
				method: "POST",
				signal: controller.signal,
			},
		);
		clearTimeout(timeoutId);

		if (!response.ok) {
			await handleFetchError(response, deps.onError);
		}
	} catch (error) {
		clearTimeout(timeoutId);
		if (error instanceof Error && error.name === "AbortError") {
			const timeoutError = new Error(
				"Docker start operation timed out after 10 seconds",
			);
			if (deps.onError) {
				deps.onError("Timeout Error", timeoutError.message);
			}
			throw timeoutError;
		}
		throw error;
	}
}

/**
 * Stop a Docker container by containerID
 */
export async function stopContainer(
	deps: ClientDeps,
	containerID: string,
	appIdent?: string,
): Promise<void> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 10000);

	try {
		let url = `${deps.baseUrl}/api/docker/stop?containerID=${encodeURIComponent(containerID)}`;
		if (appIdent) {
			url += `&appIdent=${encodeURIComponent(appIdent)}`;
		}

		const response = await deps.fetchFn(url, {
			method: "POST",
			signal: controller.signal,
		});
		clearTimeout(timeoutId);

		if (!response.ok) {
			await handleFetchError(response, deps.onError);
		}
	} catch (error) {
		clearTimeout(timeoutId);
		if (error instanceof Error && error.name === "AbortError") {
			const timeoutError = new Error(
				"Docker stop operation timed out after 10 seconds",
			);
			if (deps.onError) {
				deps.onError("Timeout Error", timeoutError.message);
			}
			throw timeoutError;
		}
		throw error;
	}
}

/**
 * Restart a Docker container by containerID
 */
export async function restartContainer(
	deps: ClientDeps,
	containerID: string,
	appIdent?: string,
): Promise<void> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 10000);

	try {
		let url = `${deps.baseUrl}/api/docker/restart?containerID=${encodeURIComponent(containerID)}`;
		if (appIdent) {
			url += `&appIdent=${encodeURIComponent(appIdent)}`;
		}

		const response = await deps.fetchFn(url, {
			method: "POST",
			signal: controller.signal,
		});
		clearTimeout(timeoutId);

		if (!response.ok) {
			await handleFetchError(response, deps.onError);
		}
	} catch (error) {
		clearTimeout(timeoutId);
		if (error instanceof Error && error.name === "AbortError") {
			const timeoutError = new Error(
				"Docker restart operation timed out after 10 seconds",
			);
			if (deps.onError) {
				deps.onError("Timeout Error", timeoutError.message);
			}
			throw timeoutError;
		}
		throw error;
	}
}

/**
 * Get container logs for a specific container ID
 */
export async function getContainerLogs(
	deps: ClientDeps,
	containerID: string,
): Promise<string> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/docker/logs?containerID=${encodeURIComponent(containerID)}`,
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return await response.text();
}

export async function streamContainerLogs(
	deps: ClientDeps,
	containerID: string,
	signal: AbortSignal,
	onLine: (line: string) => void,
	onError?: (err: Error) => void,
	tail: string = "100",
): Promise<void> {
	try {
		const response = await deps.fetchFn(
			`${deps.baseUrl}/api/docker/logs/stream?containerID=${encodeURIComponent(containerID)}&tail=${encodeURIComponent(tail)}`,
			{ signal },
		);
		if (!response.ok) {
			throw new Error(`Log stream failed: ${response.statusText}`);
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

export async function streamContainerStats(
	deps: ClientDeps,
	containerID: string,
	signal: AbortSignal,
	onData: (stats: ContainerStats) => void,
	onError?: (err: Error) => void,
): Promise<void> {
	try {
		const response = await deps.fetchFn(
			`${deps.baseUrl}/api/docker/stats/stream?containerID=${encodeURIComponent(containerID)}`,
			{ signal },
		);
		if (!response.ok) {
			throw new Error(`Stats stream failed: ${response.statusText}`);
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
							const stats = JSON.parse(line.slice(6)) as ContainerStats;
							if (stats.cpuPercent !== undefined) {
								onData(stats);
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
