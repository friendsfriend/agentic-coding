// Docker and Kubernetes route handlers (`port-environment-runtimes-to-bun`,
// sections 2 and 3).
//
// Ported from `server/pkg/server/{handlers_docker,handlers_kubernetes}.go`.
//
// The routes keep the legacy envelope exactly: query parameters are the
// contract (`containerID`, `appIdent`, `tail`), a failure is the legacy
// `{error, message, code}` body with the legacy status, and the SSE streams
// carry `data: {...}` frames. Bun owns the run/history side already, so a
// container or cluster action mutates the runtime and publishes the legacy
// event; it never allocates an action run of its own.

import type { KubernetesTargetMetadata } from "../actions/targets.ts";
import type { ContainerStatsEntry, DockerRuntimeSelection } from "./docker.ts";
import type {
	Command,
	KubernetesClusterService,
	KubernetesExec,
	Runner,
} from "./kubernetes.ts";

export interface AppForRuntime {
	readonly ident: string;
	readonly localDirectoryPath: string;
}

export interface InfraServiceForRuntime {
	readonly ident: string;
	readonly type: string;
	readonly kubernetes?: {
		readonly release: string;
		readonly namespace?: string;
	};
	readonly containerBaseName?: string;
}

export interface LegacyRuntimeEvent {
	readonly type: string;
	readonly properties: Record<string, unknown>;
	readonly timestamp: string;
}

export interface RuntimeRouteServices {
	/** Selected container runtime, or `undefined` when none is available. */
	readonly docker?: DockerRuntimeSelection;
	readonly kubernetes: KubernetesClusterService;
	readonly apps: {
		getAppByIdent(ident: string): AppForRuntime | undefined;
		getApps(): readonly AppForRuntime[];
	};
	readonly infraServices: readonly InfraServiceForRuntime[];
	/** Runtime argv boundary for kubernetes log reads. */
	readonly exec: KubernetesExec;
	/** Legacy `/api/events` fan-out. */
	readonly stream?: { publish(event: LegacyRuntimeEvent): void };
	readonly publish?: (event: LegacyRuntimeEvent) => void;
	/**
	 * Called after a container's state changed so the caller can re-read and
	 * broadcast app status. Omitted means no status owner is attached yet.
	 */
	readonly onResourceChanged?: (ident: string) => void;
	/**
	 * Records the commandless run a container lifecycle call produces. The
	 * Docker API did the work; no process ran, so the run has no commands. An
	 * omitted recorder means no action-history owner is attached yet.
	 */
	readonly recordCommandlessRun?: (input: {
		readonly title: string;
		readonly appIdent: string;
		readonly action: string;
		readonly targetLabel?: string;
		readonly error?: string;
	}) => void;
	/** Resolves the Kubernetes target a run action used, for log reads. */
	readonly resolveKubernetesTarget?: (
		appIdent: string,
		localDir: string,
	) => KubernetesTargetMetadata | undefined;
	readonly runner?: Runner;
	readonly now?: () => number;
	readonly logger?: (message: string) => void;
}

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

function legacyText(value: string): Response {
	return new Response(value, {
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function sse(stream: ReadableStream<Uint8Array>): Response {
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}

function eventFrame(value: unknown): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
}

/** Serves one Bun-owned docker or kubernetes row. */
export async function handleRuntimeRoute(
	services: RuntimeRouteServices,
	request: Request,
	url: URL,
): Promise<Response | undefined> {
	switch (url.pathname) {
		case "/api/docker/start":
			return dockerLifecycle(services, request, url, "start");
		case "/api/docker/stop":
			return dockerLifecycle(services, request, url, "stop");
		case "/api/docker/restart":
			return dockerLifecycle(services, request, url, "restart");
		case "/api/docker/logs":
			return dockerLogs(services, url);
		case "/api/docker/logs/stream":
			return dockerLogStream(services, request, url);
		case "/api/docker/stats/stream":
			return dockerStatsStream(services, request, url);
		case "/api/kubernetes/cluster":
			return kubernetesClusterStatus(services, request);
		case "/api/kubernetes/cluster/refresh":
			return kubernetesClusterStatus(services, request);
		case "/api/kubernetes/logs":
			return kubernetesLogs(services, url);
		default:
			return undefined;
	}
}

// --- docker ---------------------------------------------------------------

async function dockerLifecycle(
	services: RuntimeRouteServices,
	request: Request,
	url: URL,
	action: "start" | "stop" | "restart",
): Promise<Response> {
	if (request.method !== "POST") {
		return legacyError(405, "Method not allowed");
	}
	const containerId = url.searchParams.get("containerID") ?? "";
	const appIdent = url.searchParams.get("appIdent") ?? "";
	if (containerId === "") {
		return legacyError(400, "containerID parameter required");
	}
	const client = services.docker?.client;
	const title = `${action[0].toUpperCase()}${action.slice(1)} container ${containerId}`;
	const runAction = `docker.container.${action}`;
	if (!client) {
		const error = "no container runtime available";
		services.recordCommandlessRun?.({
			title,
			appIdent,
			action: runAction,
			targetLabel: containerId,
			error,
		});
		return legacyError(500, `Failed to ${action} container: ${error}`);
	}
	services.logger?.(
		`[INFO] ${action === "start" ? "Starting" : action === "stop" ? "Stopping" : "Restarting"} container: ${containerId} (app: ${appIdent})`,
	);
	try {
		if (action === "start") await client.startContainer(containerId);
		else if (action === "stop") await client.stopContainer(containerId);
		else await client.restartContainer(containerId);
	} catch (error) {
		services.logger?.(
			`[ERROR] Failed to ${action} container ${containerId}: ${message(error)}`,
		);
		services.recordCommandlessRun?.({
			title,
			appIdent,
			action: runAction,
			targetLabel: containerId,
			error: message(error),
		});
		return legacyError(500, `Failed to ${action} container: ${message(error)}`);
	}
	services.recordCommandlessRun?.({
		title,
		appIdent,
		action: runAction,
		targetLabel: containerId,
	});
	services.logger?.(
		`[INFO] Successfully ${pastTense(action)} container: ${containerId}`,
	);
	publish(services, `docker.container.${pastTense(action)}`, {
		containerID: containerId,
		appIdent,
	});
	if (appIdent !== "") services.onResourceChanged?.(appIdent);
	return legacyJson({
		success: true,
		containerID: containerId,
		action: pastTense(action),
	});
}

function pastTense(action: "start" | "stop" | "restart"): string {
	return action === "start"
		? "started"
		: action === "stop"
			? "stopped"
			: "restarted";
}

function publish(
	services: RuntimeRouteServices,
	type: string,
	properties: Record<string, unknown>,
): void {
	const event: LegacyRuntimeEvent = {
		type,
		properties,
		timestamp: new Date(services.now?.() ?? Date.now()).toISOString(),
	};
	services.stream?.publish(event);
	services.publish?.(event);
}

async function dockerLogs(
	services: RuntimeRouteServices,
	url: URL,
): Promise<Response> {
	const containerId = url.searchParams.get("containerID") ?? "";
	if (containerId === "") {
		return legacyError(400, "containerID parameter required");
	}
	const client = services.docker?.client;
	if (!client) {
		return legacyError(
			500,
			"Failed to fetch container logs: no container runtime available",
		);
	}
	try {
		return legacyText(await client.getContainerLogs(containerId));
	} catch (error) {
		services.logger?.(
			`[ERROR] Failed to fetch container logs: ${message(error)}`,
		);
		return legacyError(
			500,
			`Failed to fetch container logs: ${message(error)}`,
		);
	}
}

function dockerLogStream(
	services: RuntimeRouteServices,
	request: Request,
	url: URL,
): Response {
	const containerId = url.searchParams.get("containerID") ?? "";
	if (containerId === "") {
		return legacyError(400, "containerID parameter required");
	}
	const tail = url.searchParams.get("tail") ?? "100";
	const client = services.docker?.client;
	if (!client) {
		return legacyError(
			500,
			"Failed to stream logs: no container runtime available",
		);
	}
	const signal = request.signal;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const line of client.logLines(containerId, tail, signal)) {
					if (signal.aborted) break;
					controller.enqueue(eventFrame({ line }));
				}
			} catch (error) {
				if (!signal.aborted) {
					controller.enqueue(
						eventFrame({ error: `Failed to stream logs: ${message(error)}` }),
					);
				}
			} finally {
				controller.close();
			}
		},
	});
	return sse(stream);
}

function dockerStatsStream(
	services: RuntimeRouteServices,
	request: Request,
	url: URL,
): Response {
	const containerId = url.searchParams.get("containerID") ?? "";
	if (containerId === "") {
		return legacyError(400, "containerID parameter required");
	}
	const client = services.docker?.client;
	if (!client) {
		return legacyError(
			500,
			"Failed to stream stats: no container runtime available",
		);
	}
	const signal = request.signal;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const entry of client.stats(containerId, signal)) {
					if (signal.aborted) break;
					controller.enqueue(eventFrame(statsFrame(entry)));
				}
			} catch (error) {
				if (!signal.aborted) {
					controller.enqueue(
						eventFrame({ error: `Failed to stream stats: ${message(error)}` }),
					);
				}
			} finally {
				controller.close();
			}
		},
	});
	return sse(stream);
}

/** The stats entry wire shape Go's json tags produced. */
function statsFrame(entry: ContainerStatsEntry): Record<string, unknown> {
	return {
		cpuPercent: entry.cpuPercent,
		memoryUsage: entry.memoryUsage,
		memoryLimit: entry.memoryLimit,
		memoryPercent: entry.memoryPercent,
		timestamp: entry.timestamp,
	};
}

// --- kubernetes -----------------------------------------------------------

async function kubernetesClusterStatus(
	services: RuntimeRouteServices,
	request: Request,
): Promise<Response> {
	const method = request.method.toUpperCase();
	if (method !== "GET" && method !== "POST") {
		return legacyError(405, "Method not allowed");
	}
	const status = await services.kubernetes.status(request.signal);
	return legacyJson(status, 200);
}

async function kubernetesLogs(
	services: RuntimeRouteServices,
	url: URL,
): Promise<Response> {
	const appIdent = url.searchParams.get("appIdent") ?? "";
	if (appIdent === "") {
		return legacyError(400, "appIdent parameter required");
	}
	const app = services.apps.getAppByIdent(appIdent);
	const infra = services.infraServices.find(
		(service) => service.ident === appIdent,
	);
	const runner = services.runner ?? services.kubernetes.runner;
	try {
		if (app) {
			return legacyText(
				await kubernetesRunLogs(
					services,
					runner,
					appIdent,
					app.localDirectoryPath,
				),
			);
		}
		if (infra && infra.type === "kubernetes" && infra.kubernetes) {
			return legacyText(
				await kubernetesReleaseLogs(
					services,
					runner,
					infra.kubernetes.namespace ?? "default",
					infra.kubernetes.release,
				),
			);
		}
		return legacyError(404, "Kubernetes app or infrastructure not found");
	} catch (error) {
		return legacyError(500, message(error));
	}
}

/**
 * Run logs for an app's Kubernetes target: pod names first, then each pod's
 * logs prefixed with `[pod]`, matching the Go reader line for line.
 */
async function kubernetesRunLogs(
	services: RuntimeRouteServices,
	runner: Runner,
	appIdent: string,
	localDir: string,
): Promise<string> {
	const target = services.resolveKubernetesTarget?.(appIdent, localDir);
	if (!target) {
		throw new Error(`no Kubernetes run target found for ${appIdent}`);
	}
	return kubernetesReleaseLogs(
		services,
		runner,
		target.namespace ?? "default",
		target.release,
	);
}

async function kubernetesReleaseLogs(
	services: RuntimeRouteServices,
	runner: Runner,
	namespace: string,
	release: string,
): Promise<string> {
	const pods = await runKubernetes(
		services,
		runner.kubectl(
			"get",
			"pods",
			"--namespace",
			namespace,
			"-l",
			`app.kubernetes.io/instance=${release}`,
			"-o",
			'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
		),
	);
	const names = pods.trim().split(/\s+/).filter(Boolean);
	if (names.length === 0) {
		return `No pods found for release ${release} in namespace ${namespace}`;
	}
	let combined = "";
	for (const pod of names) {
		let output: string;
		try {
			output = await runKubernetes(
				services,
				runner.kubectl(
					"logs",
					"--namespace",
					namespace,
					pod,
					"--all-containers",
					"--tail",
					"500",
				),
			);
		} catch (error) {
			output = `Error fetching logs: ${message(error)}`;
		}
		for (const line of output.replace(/\n+$/, "").split("\n")) {
			if (line === "") continue;
			combined += `[${pod}] ${line}\n`;
		}
	}
	return combined;
}

/** Runs one kubernetes command, throwing the command's stderr on failure. */
async function runKubernetes(
	services: RuntimeRouteServices,
	command: Command,
): Promise<string> {
	const result = await services.exec(command);
	if (result.error) {
		throw new Error(
			result.stderr.trim() === "" ? result.error.message : result.stderr.trim(),
		);
	}
	return result.stdout;
}

/** Exported for the log-reader contract test. */
export { kubernetesReleaseLogs as kubernetesLogsForRelease };

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
