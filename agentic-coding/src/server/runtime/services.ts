// Runtime composition (`port-environment-runtimes-to-bun`, sections 2-4).
//
// One place builds the container client, the cluster service and the
// server-scoped background work (container event listener, prune poller,
// cluster status watcher). They are Bun-owned scopes with one cancellable
// signal: stopping the scope stops every listener/timer and schedules nothing
// else, which is what makes the cutover quiescent.

import type { RuntimeOperationDispatch } from "../actions/routes.ts";
import type { InfraService } from "../actions/targets.ts";
import type { App } from "../environment/config.ts";
import { createBunRuntimeDispatch } from "./dispatch.ts";
import {
	type DockerRuntimeSelection,
	runSystemPrune,
	selectRuntime,
	spawnCommandRunner,
	startEventListener,
	startPrunePoller,
} from "./docker.ts";
import {
	KubernetesClusterService,
	type KubernetesExec,
	Runner,
	spawnKubernetesExec,
	startClusterStatusWatcher,
} from "./kubernetes.ts";
import type { RuntimeRouteServices } from "./routes.ts";
import type { RunObservation } from "./run-observation.ts";
import type { ScriptInfrastructure } from "./script-infrastructure.ts";

export interface RuntimeServicesOptions {
	readonly apps: () => readonly App[];
	readonly infraServices: () => readonly InfraService[];
	readonly runtimeName?: string;
	readonly exec?: KubernetesExec;
	readonly containerCommand?: string;
	readonly containerName?: string;
	readonly env?: Record<string, string | undefined>;
	readonly logger?: (message: string) => void;
	readonly stream?: { publish(event: unknown): void };
	readonly publish?: (event: unknown) => void;
	readonly onResourceChanged?: (ident: string) => void;
	readonly recordCommandlessRun?: RuntimeRouteServices["recordCommandlessRun"];
	/** Script infrastructure lifecycle; the action engine defers script starts to it. */
	readonly scriptInfra?: ScriptInfrastructure;
	/** Run-target/Kubernetes observer the app family reads. */
	readonly observation?: RunObservation;
	readonly resolveKubernetesTarget?: RuntimeRouteServices["resolveKubernetesTarget"];
	readonly now?: () => number;
	readonly dockerClientOverride?: DockerRuntimeSelection;
	readonly statusIntervalMs?: number;
	readonly pruneStartupDelayMs?: number;
	readonly pruneIntervalMs?: number;
	readonly startBackground?: boolean;
}

export interface RuntimeServices {
	readonly routes: RuntimeRouteServices;
	readonly docker?: DockerRuntimeSelection;
	readonly kubernetes: KubernetesClusterService;
	readonly scriptInfra?: ScriptInfrastructure;
	readonly dispatch: RuntimeOperationDispatch;
	/** Cancels every listener, watcher and timer this composition started. */
	stop(): void;
	/** The scope's signal: a late-attached owner (status pollers) shares it. */
	readonly signal: AbortSignal;
}

/**
 * Builds the runtime capability over the configured environment. A missing
 * container runtime is not an error: the routes then report the runtime
 * unavailable instead of the server refusing to start.
 */
export async function createRuntimeServices(
	options: RuntimeServicesOptions,
): Promise<RuntimeServices> {
	const runtimeName =
		options.runtimeName ??
		options.env?.DEVENV_CONTAINER_RUNTIME ??
		process.env.DEVENV_CONTAINER_RUNTIME ??
		"docker";
	let docker = options.dockerClientOverride;
	if (!docker) {
		try {
			docker = await selectRuntime(runtimeName, {
				...(options.env ? { env: options.env } : {}),
			});
		} catch (error) {
			options.logger?.(
				`[runtime] container runtime selection failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	const containerName =
		options.containerName ?? docker?.runtime.name ?? runtimeName;
	const runner = new Runner({
		containerCommand:
			options.containerCommand ?? docker?.runtime.command ?? runtimeName,
		containerName,
	});
	const exec = options.exec ?? spawnKubernetesExec();
	const kubernetes = new KubernetesClusterService({
		runner,
		exec,
		...(options.now ? { now: options.now } : {}),
		...(options.logger
			? {
					observe: (observation) =>
						options.logger?.(
							`[kubernetes] ${observation.command.name} ${observation.command.args.join(" ")}`,
						),
				}
			: {}),
	});

	const controller = new AbortController();
	const routes: RuntimeRouteServices = {
		...(docker ? { docker } : {}),
		kubernetes,
		apps: {
			getAppByIdent: (ident) =>
				options.apps().find((app) => app.ident === ident),
			getApps: () => options.apps(),
		},
		infraServices:
			options.infraServices() as unknown as RuntimeRouteServices["infraServices"],
		exec,
		runner,
		...(options.stream ? { stream: options.stream as never } : {}),
		...(options.publish ? { publish: options.publish as never } : {}),
		...(options.onResourceChanged
			? { onResourceChanged: options.onResourceChanged }
			: {}),
		...(options.recordCommandlessRun
			? { recordCommandlessRun: options.recordCommandlessRun }
			: {}),
		...(options.resolveKubernetesTarget
			? { resolveKubernetesTarget: options.resolveKubernetesTarget }
			: {}),
		...(options.now ? { now: options.now } : {}),
		...(options.logger ? { logger: options.logger } : {}),
	};

	const dispatch = createBunRuntimeDispatch({
		...(docker ? { docker } : {}),
		kubernetes,
	});

	if (options.startBackground !== false) {
		startRuntimeBackgroundWork({
			controller,
			docker,
			kubernetes,
			apps: options.apps,
			infraServices: options.infraServices,
			...(options.logger ? { logger: options.logger } : {}),
			...(options.statusIntervalMs !== undefined
				? { statusIntervalMs: options.statusIntervalMs }
				: {}),
			...(options.pruneStartupDelayMs !== undefined
				? { pruneStartupDelayMs: options.pruneStartupDelayMs }
				: {}),
			...(options.pruneIntervalMs !== undefined
				? { pruneIntervalMs: options.pruneIntervalMs }
				: {}),
		});
	}

	return {
		routes,
		signal: controller.signal,
		...(docker ? { docker } : {}),
		kubernetes,
		...(options.scriptInfra ? { scriptInfra: options.scriptInfra } : {}),
		dispatch,
		stop: () => controller.abort(),
	};
}

/** The server-scoped background work for the runtime families. */
export function startRuntimeBackgroundWork(input: {
	readonly controller: AbortController;
	readonly docker?: DockerRuntimeSelection;
	readonly kubernetes: KubernetesClusterService;
	readonly apps: () => readonly App[];
	readonly infraServices: () => readonly InfraService[];
	readonly logger?: (message: string) => void;
	readonly statusIntervalMs?: number;
	readonly pruneStartupDelayMs?: number;
	readonly pruneIntervalMs?: number;
}): void {
	const signal = input.controller.signal;
	if (input.docker) {
		// One event listener: a container that changed is attributed to the app or
		// infrastructure service that owns its name, then re-read once.
		startEventListener({
			client: input.docker.client,
			signal,
			...(input.logger ? { logger: input.logger } : {}),
			onEvent: (event) => {
				const name = event.containerName;
				if (name === "") return;
				const ident = findIdentByContainerName(
					name,
					input.apps(),
					input.infraServices(),
				);
				if (ident === "") return;
				input.logger?.(
					`[Docker] Event ${event.action} for ${ident} (container ${name})`,
				);
			},
		});
	}
	startPrunePoller({
		signal,
		runCommand: spawnCommandRunner(),
		...(input.logger ? { logger: input.logger } : {}),
		...(input.pruneStartupDelayMs !== undefined
			? { startupDelayMs: input.pruneStartupDelayMs }
			: {}),
		...(input.pruneIntervalMs !== undefined
			? { intervalMs: input.pruneIntervalMs }
			: {}),
	});
	startClusterStatusWatcher({
		service: input.kubernetes,
		signal,
		onStatus: (status) => {
			input.logger?.(`[Kubernetes] cluster state: ${status.state}`);
		},
		...(input.statusIntervalMs !== undefined
			? { intervalMs: input.statusIntervalMs }
			: {}),
		...(input.logger ? { logger: input.logger } : {}),
	});
}

/** The app or infrastructure service a container name belongs to. */
export function findIdentByContainerName(
	name: string,
	apps: readonly App[],
	infraServices: readonly InfraService[],
): string {
	for (const app of apps) {
		if (matchesTarget(name, app.ident, app.containerBaseName ?? app.ident)) {
			return app.ident;
		}
	}
	for (const service of infraServices) {
		if (
			matchesTarget(
				name,
				service.ident,
				(service as { containerBaseName?: string }).containerBaseName ?? "",
			)
		) {
			return service.ident;
		}
	}
	return "";
}

function matchesTarget(
	name: string,
	ident: string,
	containerBaseName: string,
): boolean {
	// Imported lazily to keep this module's import graph small in tests.
	return dockerNameMatches(name, ident, containerBaseName);
}

// Re-exported so the composition does not import the pure matcher twice.
import { containerNameMatches as dockerNameMatches } from "./docker.ts";

/** Prunes every installed runtime once; exported for the prune contract test. */
export async function pruneOnce(
	runCommand: Parameters<typeof runSystemPrune>[0]["runCommand"],
	logger?: (message: string) => void,
): Promise<void> {
	await runSystemPrune({ runCommand, ...(logger ? { logger } : {}) });
}
