// App-family composition (`port-environment-runtimes-to-bun`, task 4.4).
//
// The app routes read the Bun environment authority rather than re-parsing
// configuration: the manager owns the catalog, the Git capability owns branch
// and status, and the provider store owns the source type. Only the
// infrastructure observation (script lifecycle, Kubernetes release status,
// last-run target) is injected, because those owners are separate.
import path from "node:path";
import type { App, InfraService } from "../environment/config.ts";
import type { EnvironmentManager } from "../environment/manager.ts";
import type { GitRepository } from "../integrations/git-repository.ts";
import type { ProviderStore } from "../integrations/provider-store.ts";
import type { AppFamilyServices, ScriptStatusShape } from "./app-routes.ts";

export type { ScriptStatusShape };

import type { DockerRuntimeSelection } from "./docker.ts";
import type { RunObservation } from "./run-observation.ts";

export type { AppFamilyServices };

import { StatusManager } from "./status.ts";

export interface AppFamilyServicesOptions {
	readonly configDir: string;
	readonly homeDir: string;
	readonly manager: EnvironmentManager;
	readonly git: GitRepository;
	readonly providers: ProviderStore;
	readonly docker?: DockerRuntimeSelection;
	readonly scriptStatus?: AppFamilyServices["scriptStatus"];
	readonly kubernetesStatus?: AppFamilyServices["kubernetesStatus"];
	readonly runObservation?: AppFamilyServices["runObservation"];
	/** The run-target/Kubernetes observer the app family reads. */
	readonly observation?: RunObservation;
	readonly publish?: (event: {
		type: string;
		properties: Record<string, unknown>;
		timestamp: string;
	}) => void;
	readonly logger?: (message: string) => void;
	readonly now?: () => Date;
}

/** Builds the app-family route capability over the environment authority. */
export function createAppFamilyServices(
	options: AppFamilyServicesOptions,
): AppFamilyServices {
	const statusManager = new StatusManager(options.now);
	return {
		...(options.docker ? { docker: options.docker } : {}),
		configDir: options.configDir,
		homeDir: options.homeDir,
		apps: () => options.manager.getApps(),
		infraServices: () => options.manager.getInfraServices(),
		getAppByIdent: (ident) => options.manager.getAppByIdent(ident),
		getInfraServiceByIdent: (ident) =>
			options.manager.getInfraServiceByIdent(ident),
		getDisplayName: (ident) => options.manager.getDisplayName(ident),
		getProjectCatalog: () => options.manager.getProjectCatalog(),
		git: {
			getCurrentBranch: (app) => options.git.getCurrentBranch(app),
			getStatus: (app) => options.git.getStatus(app),
		},
		loadConfig: () => options.manager.loadConfig(),
		addApp: (app: App) => options.manager.addApp(app),
		removeApp: (ident, deleteDir) =>
			options.manager.removeApp(ident, deleteDir),
		setMainWorktreeBranch: (ident, branch) =>
			options.manager.setMainWorktreeBranch(ident, branch),
		cloneApp: (app) => {
			options.git.updateOrCreateRepo(app);
		},
		providers: {
			get: (name) => options.providers.get(name),
		},
		statusManager,
		...(options.scriptStatus ? { scriptStatus: options.scriptStatus } : {}),
		...(options.kubernetesStatus
			? { kubernetesStatus: options.kubernetesStatus }
			: {}),
		...(options.observation
			? {
					runObservation: async (ident: string) => {
						const observation = options.observation;
						if (!observation) return {};
						const app = options.manager.getAppByIdent(ident);
						const lastRunRuntime = observation.lastRunRuntime(ident);
						const shellTmuxRunActive =
							await observation.isShellTmuxRunActive(ident);
						const kubernetesStatus = app
							? await observation.discoverKubernetesRunStatus(
									ident,
									app.localDirectoryPath,
								)
							: undefined;
						return {
							...(kubernetesStatus === undefined ? {} : { kubernetesStatus }),
							...(lastRunRuntime === "" ? {} : { lastRunRuntime }),
							shellTmuxRunActive,
							...(observation.runTargetInfo(ident) === undefined
								? {}
								: { runTargetInfo: observation.runTargetInfo(ident) }),
						};
					},
				}
			: {}),
		...(options.runObservation
			? { runObservation: options.runObservation }
			: {}),
		...(options.publish ? { publish: options.publish } : {}),
		...(options.logger ? { logger: options.logger } : {}),
		...(options.now ? { now: options.now } : {}),
	};
}

/** Resolves the compose file an infrastructure service starts from. */
export function infrastructureComposeFile(
	configDir: string,
	ident: string,
): string {
	return path.join(configDir, "apps", "compose", `${ident}-compose.yml`);
}

export type { App, InfraService };
