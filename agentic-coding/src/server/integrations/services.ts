// Composition for the Bun-served integration families: the provider store, the
// Git capability and the app lookup the routes resolve an ident through
// (`port-git-providers-and-ai-to-bun`, tasks 2.1-2.5).
//
// Credentials are resolved here, on the Bun side, so a Git operation never
// carries a token across the private adapter boundary.
import path from "node:path";
import {
	type ActionRouteContext,
	type ActionRouteServices,
	createActionRouteContext,
	type RuntimeOperationDispatch,
	rebuildDefinitions,
} from "../actions/routes.ts";
import type { InfraService } from "../actions/targets.ts";
import type { App } from "../environment/config.ts";
import type { EnvironmentManager } from "../environment/manager.ts";
import {
	type AppFamilyServices,
	createAppFamilyServices,
} from "../runtime/app-services.ts";
import { DependencyLeases } from "../runtime/leases.ts";
import type { RuntimeRouteServices } from "../runtime/routes.ts";
import type { RunObservation } from "../runtime/run-observation.ts";
import type { ScriptInfrastructure } from "../runtime/script-infrastructure.ts";
import { GitRepository } from "./git-repository.ts";
import {
	PROVIDER_TYPE_GITHUB,
	PROVIDER_TYPE_GITLAB,
	ProviderStore,
} from "./provider-store.ts";
import type { IntegrationServices } from "./routes.ts";

export interface IntegrationServicesOptions {
	readonly manager: EnvironmentManager;
	/** The Bun-owned state store, for action/script history. */
	readonly state: EnvironmentStateStorePort;
	readonly configDir: string;
	readonly homeDir?: string;
	readonly fetch?: typeof fetch;
	readonly logger?: (message: string) => void;
	/**
	 * SDK-only container/Kubernetes operations that no Bun capability covers yet.
	 * Omitted means the action engine fails such a step loudly instead of
	 * reporting success for work that did not happen.
	 */
	readonly runtimeOperation?: RuntimeOperationDispatch;
	/** Event fan-out for `GET /api/events`; the server supplies the broker. */
	readonly publish?: ActionRouteServices["publish"];
	/** Tool probe override, so a test does not depend on the host's tools. */
	readonly tools?: ActionRouteServices["tools"];
	/** Container/Kubernetes capability; the `docker`/`kubernetes` route families. */
	readonly runtime?: RuntimeRouteServices;
	/** Script/Kubernetes infrastructure observation for the app family. */
	readonly infrastructure?: {
		readonly scriptStatus?: AppFamilyServices["scriptStatus"];
		readonly kubernetesStatus?: AppFamilyServices["kubernetesStatus"];
		readonly runObservation?: AppFamilyServices["runObservation"];
	};
	/** Script infrastructure lifecycle, owned by the runtime composition. */
	readonly scriptInfra?: ScriptInfrastructure;
	/** Run-target/Kubernetes observer, owned by the runtime composition. */
	readonly observation?: RunObservation;
}

/**
 * Build the integration services over the Bun-owned environment authority.
 *
 * Credential routing matches the Go `multiAuthProvider`: an app that names a
 * provider wins, otherwise the first provider whose type matches the host is
 * used, so GitHub and GitLab credentials never leak into each other.
 */
export function createIntegrationServices(
	options: IntegrationServicesOptions,
): IntegrationServices {
	const providers = new ProviderStore(
		path.join(options.configDir, "providers"),
		path.join(options.configDir, ".env"),
	);
	try {
		providers.load();
	} catch (error) {
		options.logger?.(
			`[WARN] providers: initial load failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	// The durable leases a previous process left are adopted here, so a restart
	// never treats an owned dependency as unowned.
	const leases = new DependencyLeases({
		state:
			options.state as unknown as import("../runtime/leases.ts").DependencyLeaseStore,
		...(options.logger ? { logger: options.logger } : {}),
	});
	const adoptedLeases = leases.adopt();
	if (adoptedLeases > 0) {
		options.logger?.(`[leases] adopted ${adoptedLeases} dependency lease(s)`);
	}
	const git = new GitRepository({
		auth: (repositoryUrl) =>
			credentialsFor(providers, options.manager, repositoryUrl),
		logger: options.logger,
	});
	const actionContext = createActionRouteContext({
		configDir: options.configDir,
		homeDir: options.homeDir ?? path.dirname(options.configDir),
		apps: {
			getAppByIdent: (ident) => options.manager.getAppByIdent(ident),
			getApps: () => options.manager.getApps(),
		},
		// Infrastructure services live in the same configured environment the
		// manager already loaded.
		infraServices: options.manager.getInfraServices() as InfraService[],
		state: options.state,
		leases,
		// A script infrastructure start is launched by its lifecycle owner.
		...(options.scriptInfra ? { scriptInfra: options.scriptInfra } : {}),
		// A completed run records the target the status API publishes.
		...(options.observation
			? {
					recordRunTarget: (definition, app) =>
						options.observation?.recordCompletedRun(definition, app) ?? false,
				}
			: {}),
		...(options.observation ? { observation: options.observation } : {}),
		// Until the server's broker exists the stream is still the source of truth
		// for the action view; the broker is attached by the composition root.
		publish: options.publish ?? (() => {}),
		...(options.runtimeOperation ? { runtime: options.runtimeOperation } : {}),
		...(options.tools ? { tools: options.tools } : {}),
		...(options.logger ? { logger: options.logger } : {}),
	});

	const appFamily = createAppFamilyServices({
		configDir: options.configDir,
		homeDir: options.homeDir ?? path.dirname(options.configDir),
		manager: options.manager,
		git,
		providers,
		...(options.runtime ? { docker: options.runtime.docker } : {}),
		// A script service's status comes from its lifecycle owner when one is
		// attached: a remembered flag is never reported as a running service.
		...(options.scriptInfra
			? {
					scriptStatus: (ident: string) => {
						const infra = options.scriptInfra;
						if (!infra)
							throw new Error("script infrastructure is not attached");
						return infra.status(ident);
					},
				}
			: {}),
		...(options.infrastructure?.scriptStatus
			? { scriptStatus: options.infrastructure.scriptStatus }
			: {}),
		...(options.infrastructure?.kubernetesStatus
			? { kubernetesStatus: options.infrastructure.kubernetesStatus }
			: {}),
		...(options.infrastructure?.runObservation
			? { runObservation: options.infrastructure.runObservation }
			: {}),
		...(options.publish ? { publish: options.publish } : {}),
		...(options.logger ? { logger: options.logger } : {}),
	});

	return {
		providers,
		git,
		appFamily,
		actions: actionContext,
		apps: {
			getAppByIdent: (ident) => options.manager.getAppByIdent(ident),
			getApps: () => options.manager.getApps(),
			updateAppActiveWorktree: (ident, branch) =>
				options.manager.updateAppActiveWorktree(ident, branch),
			loadConfig: () => options.manager.loadConfig(),
		},
		...(options.runtime ? { runtime: options.runtime } : {}),
		...(options.fetch ? { fetch: options.fetch } : {}),
		...(options.logger ? { logger: options.logger } : {}),
	};
}

export interface EnvironmentStateStorePort {
	addActionEvent(eventJson: string, maxEntries?: number): void;
	getActionEventsSince(limit: number, since: Date): string[];
	getActionEventsBetween(limit: number, since: Date, before: Date): string[];
	addActionLogEvent(
		runId: string,
		stepId: string,
		eventJson: string,
		maxEntries?: number,
	): void;
	getActionLogEvents(runId: string, stepId: string, limit?: number): string[];
	getScriptArgsHistory(
		relativePath: string,
		limit?: number,
	): Array<Record<string, string>>;
	addScriptArgsHistory(
		relativePath: string,
		values: Record<string, string>,
		maxEntries?: number,
	): void;
	/** Durable dependency leases (adopted on startup, released by a stop). */
	getDependencyLeases(): import("../runtime/leases.ts").DependencyLease[];
	setDependencyLease(
		lease: import("../runtime/leases.ts").DependencyLease,
	): void;
	deleteDependencyLease(targetId: string, ownerRunId: string): void;
}

/** Rebuilds the definition snapshot from the current configuration. */
export async function rebuildActionDefinitions(
	context: ActionRouteContext,
): Promise<void> {
	await rebuildDefinitions(context.services, context.registry);
}

/** Per-URL credential resolution; an unknown URL resolves to no credentials. */
export function credentialsFor(
	providers: ProviderStore,
	manager: Pick<EnvironmentManager, "getApps">,
	repositoryUrl: string,
): { username: string; token: string } {
	for (const app of manager.getApps() as App[]) {
		if (app.repositoryPath !== repositoryUrl) continue;
		if (!app.provider) continue;
		return providers.credentialsFor(app.provider);
	}
	for (const provider of providers.list()) {
		if (provider.username === "" || provider.token === "") continue;
		const isGitHub = repositoryUrl.includes("github.com");
		if (provider.type === PROVIDER_TYPE_GITHUB && isGitHub)
			return { username: provider.username, token: provider.token };
		if (provider.type === PROVIDER_TYPE_GITLAB && !isGitHub)
			return { username: provider.username, token: provider.token };
	}
	return { username: "", token: "" };
}
