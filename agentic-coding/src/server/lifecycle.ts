// Named composition root for the unified Bun workflow/telemetry server
// (expose-unified-bun-backend, task 2.1). The same executable runs the TUI or
// this server: the server owns the workflow application/observations, the
// event broker, credential interactions and the private Go delegation. Native
// Bun/Promise I/O lives here; operation handlers stay transport-agnostic.

import type { SignalRouter } from "../tui/otel/receiver/index.ts";
import { createServerApp, type ServerApp } from "./app.ts";
import { createInstanceAuthority } from "./auth.ts";
import { CredentialRegistry } from "./credentials.ts";
import { EventBroker } from "./events.ts";
import type { ServerOperations } from "./handlers.ts";
import {
	type OwnedTelemetryReceivers,
	startTelemetryReceivers,
	type TelemetryReceiverConfig,
} from "./receivers.ts";
import {
	startWorkflowEventHub,
	type WorkflowEventHub,
} from "./subscriptions.ts";
import { type TelemetryOperations, TelemetryService } from "./telemetry.ts";

export const DEFAULT_WORKFLOW_SERVER_PORT = 4051;

export interface StartWorkflowServerOptions {
	readonly port?: number;
	readonly hostname?: string;
	readonly instance?: string;
	/** Private Go listener to delegate unported environment routes to. */
	readonly environmentBaseUrl?: string;
	readonly environmentToken?: string;
	readonly version?: string;
	/** Override the application operations (transport tests). */
	readonly operations?: ServerOperations;
	/** Injected telemetry operations (transport tests). */
	readonly telemetry?: TelemetryOperations;
	/** When set (and no `telemetry` is injected) the server owns a
	 * `TelemetryService` at this database directory. */
	readonly telemetryDbPath?: string;
	/** When true the server owns a `TelemetryService` at the default database
	 * directory. */
	readonly ownTelemetry?: boolean;
	/** Telemetry receiver listeners the server should own. */
	readonly receivers?: TelemetryReceiverConfig;
	/** Sink the server's receivers route decoded signals into (the shell's live
	 * view stores). Required when `receivers` is set. */
	readonly signalSink?: SignalRouter;
	/** Injected workflow refresh hub (transport tests). */
	readonly hub?: WorkflowEventHub;
}

export interface OwnedWorkflowServer {
	readonly url: string;
	readonly port: number;
	readonly instance: string;
	readonly token: string;
	readonly app: ServerApp;
	stop(): Promise<void>;
}

/** Start the loopback workflow/telemetry server. `port: 0` lets the OS assign
 * one (used by the TUI and tests) and the assigned port is read back from the
 * listener. */
export async function startWorkflowServer(
	options: StartWorkflowServerOptions = {},
): Promise<OwnedWorkflowServer> {
	const authority = createInstanceAuthority(options.instance);
	const events = new EventBroker(authority.instance);
	const credentials = new CredentialRegistry();
	const ownedTelemetry = options.telemetry
		? undefined
		: options.telemetryDbPath !== undefined
			? new TelemetryService(options.telemetryDbPath)
			: options.ownTelemetry
				? new TelemetryService()
				: undefined;
	const telemetry = options.telemetry ?? ownedTelemetry;
	const hub = options.hub ?? startWorkflowEventHub(events);
	const app = createServerApp({
		authority,
		events,
		credentials,
		hub,
		...(telemetry ? { telemetry } : {}),
		...(options.environmentBaseUrl
			? { environmentBaseUrl: options.environmentBaseUrl }
			: {}),
		...(options.environmentToken
			? { environmentToken: options.environmentToken }
			: {}),
		...(options.version ? { version: options.version } : {}),
		...(options.operations ? { operations: options.operations } : {}),
	});
	const listener = Bun.serve({
		hostname: options.hostname ?? "127.0.0.1",
		port: options.port ?? 0,
		fetch: (request) => app.fetch(request),
	});
	const ownedReceivers: OwnedTelemetryReceivers | undefined =
		options.receivers && options.signalSink
			? await startTelemetryReceivers(options.receivers, options.signalSink)
			: undefined;
	const assignedPort = listener.port ?? options.port ?? 0;
	const url = `http://${listener.hostname}:${assignedPort}`;
	let stopped = false;
	return {
		url,
		port: assignedPort,
		instance: authority.instance,
		token: authority.token,
		app,
		stop: async () => {
			if (stopped) return;
			stopped = true;
			credentials.cancelAll();
			events.closeAll();
			hub.stop();
			await ownedReceivers?.stop();
			ownedTelemetry?.close();
			await listener.stop(true);
		},
	};
}
