// Status broadcast pollers
// (`port-environment-runtimes-to-bun`, task 4.4).
//
// Ported from `server/pkg/server/server.go` (`startGitPoller`,
// `startReconciliationPoller`, `startScriptHealthPoller`,
// `broadcastStatusUpdated`).
//
// Three properties are load-bearing:
//
//   - **one signature per ident.** A status event is only published when the
//     properties changed, so a poller that finds nothing new is silent instead
//     of flooding the stream.
//   - **the pollers are one cancellable scope.** A shutdown during an interval
//     stops every poller and schedules nothing else.
//   - **a poll never invents a state.** The properties come from the same
//     builder the status route uses, so a push and a read agree.
import type { App, InfraService } from "../environment/config.ts";
import {
	type AppFamilyServices,
	appStatusProperties,
	infraStatusProperties,
} from "./app-routes.ts";
import type { DockerInfo } from "./docker.ts";
import { sleepUntilAborted } from "./docker.ts";

export interface StatusEvent {
	readonly type: string;
	readonly properties: Record<string, unknown>;
	readonly timestamp: string;
}

export interface StatusBroadcasterOptions {
	readonly services: AppFamilyServices;
	readonly signal: AbortSignal;
	/** Publishes one event; the legacy stream and the subscription hub. */
	readonly publish: (event: StatusEvent) => void;
	readonly gitIntervalMs?: number;
	readonly reconciliationIntervalMs?: number;
	readonly scriptIntervalMs?: number;
	readonly now?: () => Date;
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly logger?: (message: string) => void;
}

/** Deduplicates and publishes `status.updated` events for apps and services. */
export class StatusBroadcaster {
	private readonly signatures = new Map<string, string>();
	private readonly publish: (event: StatusEvent) => void;
	private readonly now: () => Date;

	constructor(options: {
		readonly publish: (event: StatusEvent) => void;
		readonly now?: () => Date;
	}) {
		this.publish = options.publish;
		this.now = options.now ?? (() => new Date());
	}

	/** Publishes unless the properties are byte-identical to the last push. */
	publishStatus(ident: string, properties: Record<string, unknown>): boolean {
		const signature = JSON.stringify(properties);
		if (this.signatures.get(ident) === signature) return false;
		this.signatures.set(ident, signature);
		this.publish({
			type: "status.updated",
			properties,
			timestamp: this.now().toISOString(),
		});
		return true;
	}

	/** How many idents currently have a published signature. */
	tracked(): number {
		return this.signatures.size;
	}
}

/** Starts the three pollers on one signal. */
export function startStatusPollers(options: StatusBroadcasterOptions): {
	readonly broadcaster: StatusBroadcaster;
} {
	const sleep = options.sleep ?? sleepUntilAborted;
	const broadcaster = new StatusBroadcaster({
		publish: options.publish,
		...(options.now ? { now: options.now } : {}),
	});
	const appDockerInfo = async (): Promise<Map<string, DockerInfo>> => {
		const docker = options.services.docker;
		if (!docker) return new Map();
		const targets = options.services
			.apps()
			.filter((app) => app.appType === "app")
			.map((app) => ({
				ident: app.ident,
				containerBaseName: app.containerBaseName ?? app.ident,
			}));
		if (targets.length === 0) return new Map();
		try {
			return await docker.client.batchGetInfo(targets, []);
		} catch {
			return new Map();
		}
	};
	const infraDockerInfo = async (): Promise<Map<string, DockerInfo>> => {
		const docker = options.services.docker;
		if (!docker) return new Map();
		const targets = options.services
			.infraServices()
			.filter((service) => service.type === "" || service.type === "docker")
			.map((service) => ({
				ident: service.ident,
				containerBaseName: service.containerBaseName ?? service.ident,
			}));
		if (targets.length === 0) return new Map();
		try {
			return await docker.client.batchGetInfo([], targets);
		} catch {
			return new Map();
		}
	};
	const publishApps = async (): Promise<void> => {
		const dockerInfo = await appDockerInfo();
		for (const app of options.services.apps()) {
			const observed: DockerInfo = dockerInfo.get(app.ident) ?? {
				Status: "not found",
				ContainerID: "",
				Ports: "",
			};
			try {
				broadcaster.publishStatus(
					app.ident,
					await appStatusProperties(options.services, app, observed),
				);
			} catch (error) {
				options.logger?.(
					`[status] app ${app.ident} failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
	};
	const publishInfra = async (): Promise<void> => {
		const dockerInfo = await infraDockerInfo();
		for (const service of options.services.infraServices()) {
			try {
				broadcaster.publishStatus(
					service.ident,
					await infraStatusProperties(
						options.services,
						service,
						dockerInfo.get(service.ident),
					),
				);
			} catch (error) {
				options.logger?.(
					`[status] infrastructure ${service.ident} failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
	};

	// Git poller: branch and status changes (5s).
	void (async () => {
		for (;;) {
			await sleep(options.gitIntervalMs ?? 5000, options.signal);
			if (options.signal.aborted) return;
			await publishApps();
		}
	})();

	// Reconciliation poller: every app and service, changed or not (60s).
	void (async () => {
		for (;;) {
			await sleep(options.reconciliationIntervalMs ?? 60_000, options.signal);
			if (options.signal.aborted) return;
			await publishApps();
			await publishInfra();
		}
	})();

	// Script health poller: script infrastructure run state (5s).
	void (async () => {
		for (;;) {
			await sleep(options.scriptIntervalMs ?? 5000, options.signal);
			if (options.signal.aborted) return;
			for (const service of options.services.infraServices()) {
				if (service.type !== "script") continue;
				try {
					broadcaster.publishStatus(
						service.ident,
						await infraStatusProperties(options.services, service),
					);
				} catch (error) {
					options.logger?.(
						`[status] script ${service.ident} failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
		}
	})();

	return { broadcaster };
}

/** The apps and services a status poll reads, for the poller's own fixtures. */
export type StatusPollerInputs = {
	readonly apps: readonly App[];
	readonly infraServices: readonly InfraService[];
};
