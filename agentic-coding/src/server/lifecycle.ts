// Named composition root for the unified Bun workflow/telemetry/environment
// server (single-Bun-application): the same executable runs the TUI or this
// server, and one process owns the workflow application, observations, the
// event broker, credential interactions, the environment state/catalog
// authority, the legacy devenv surface and the telemetry receivers. Native
// Bun/Promise I/O lives here; operation handlers stay transport-agnostic.

import {
	clearEnvironmentServer,
	publishEnvironmentServer,
} from "../agent-host/environment-capability.ts";
import { orchestratorRuntimeDir } from "../orchestrator-state.ts";
import { LAYA_LOCAL_PROVIDER } from "../workflow/classifier-providers.ts";
import {
	type AgentsConfig,
	DEFAULT_ORCHESTRATOR_EVENT_BURST_LIMIT,
	DEFAULT_ORCHESTRATOR_EVENT_BURST_WINDOW_SECONDS,
	DEFAULT_ORCHESTRATOR_MONITOR,
	DEFAULT_ORCHESTRATOR_RECONCILE_SECONDS,
	DEFAULT_ORCHESTRATOR_STALL_MINUTES,
	orchestratorEventBurstLimit,
	orchestratorEventBurstWindowSeconds,
	orchestratorMonitorMode,
	orchestratorReconcileSeconds,
	orchestratorStallMinutes,
} from "../workflow/profiles.ts";
import { createServerApp, type ServerApp } from "./app.ts";
import {
	createInstanceAuthority,
	instanceTokenFile,
	publishInstanceToken,
	removeInstanceToken,
} from "./auth.ts";
import {
	selectedClassifierProvider,
	startSelectedLocalClassifier,
} from "./classifier.ts";
import { loadAgentConfig } from "./config.ts";
import { CredentialRegistry } from "./credentials.ts";
import { TraceIndex } from "./debug/trace-index.ts";
import { diagnosticsSection } from "./diagnostics/instance.ts";
import type { EnvironmentAuthority } from "./environment/private-api.ts";
import {
	publishEnvironmentDiscovery,
	removeEnvironmentDiscovery,
} from "./environment-discovery.ts";
import { EventBroker } from "./events.ts";
import type { ServerOperations } from "./handlers.ts";
import { serverOperations } from "./handlers.ts";
import type { IntegrationServices } from "./integrations/routes.ts";
import { rebuildActionDefinitions } from "./integrations/services.ts";
import type { SignalRouter } from "./receivers/index";
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
import {
	createWorkflowEventBus,
	type WorkflowEventBus,
} from "./workflow-event-bus.ts";
import { enrichWorkflowEvent } from "./workflow-event-sources.ts";

export const DEFAULT_WORKFLOW_SERVER_PORT = 4051;

/** Default port of the unified server's public surface (the devenv environment
 * address clients have always used). */
export const DEFAULT_ENVIRONMENT_PORT = 4050;

export interface StartWorkflowServerOptions {
	readonly port?: number;
	readonly hostname?: string;
	readonly instance?: string;
	/** Instance capability. Generated when omitted; the shell passes the token it
	 * already exported to the environment client, so no window exists where a
	 * client request cannot authenticate. */
	readonly token?: string;
	readonly version?: string;
	/** Environment roots reported by the health route. */
	readonly homeDir?: string;
	readonly configDir?: string;
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
	/** Bun-owned environment state/catalog authority (migrated mode: the Bun
	 * server is the sole environment-state writer and config authority). */
	readonly environment?: EnvironmentAuthority;
	/** Injected workflow refresh hub (transport tests). */
	readonly hub?: WorkflowEventHub;
	/** Injected workflow event catalog + subscription registry (transport tests).
	 * Absent: the server builds the production one. */
	readonly eventBus?: WorkflowEventBus;
	/** Bun-served legacy integration families (Git, providers, repository
	 * search): the whole legacy `/api/*` surface. */
	readonly integrations?: IntegrationServices;
}

export interface OwnedWorkflowServer {
	readonly url: string;
	readonly port: number;
	readonly instance: string;
	readonly token: string;
	readonly app: ServerApp;
	/** The application operations and telemetry service this server serves, so
	 * the composition root can build an in-process gateway over the same
	 * instances instead of opening a socket to itself. */
	readonly operations: ServerOperations;
	readonly telemetry?: TelemetryOperations;
	stop(): Promise<void>;
}

/** How long a resolved `[agents.orchestrator]` value is reused. The bus reads the
 * master switch per delivered event and per debounced read, and resolving it is
 * a layered read + deep merge of every configuration document; one second of
 * staleness is the price of not doing that per event, and an edit still applies
 * without a restart. */
const AGENTS_CACHE_TTL_MS = 1_000;

/** Memoize a read of `[agents.orchestrator]` for a short window, so the bus can
 * re-read the setting without re-resolving the whole layered configuration on
 * every event. */
function memoizedAgents<T>(
	read: (agents: AgentsConfig | undefined) => T,
	fallback: T,
): () => T {
	let cache: { at: number; value: T } | undefined;
	return () => {
		const at = Date.now();
		if (cache && at - cache.at < AGENTS_CACHE_TTL_MS) return cache.value;
		try {
			const value = read(loadAgentConfig().agents);
			cache = { at, value };
			return value;
		} catch {
			// A broken configuration is cached too, so re-reading it costs one
			// attempt per window instead of one per event; the fallback is still
			// adopted within the window once the document becomes readable.
			cache = { at, value: fallback };
			return fallback;
		}
	};
}

/** Start the loopback workflow/telemetry server. `port: 0` lets the OS assign
 * one (used by the TUI and tests) and the assigned port is read back from the
 * listener. */
export async function startWorkflowServer(
	options: StartWorkflowServerOptions = {},
): Promise<OwnedWorkflowServer> {
	// Both the TUI-owned and headless server need a published registry before
	// clients start polling readiness. Compile before acquiring server resources.
	const actions = options.integrations?.actions;
	if (actions && actions.registry.snapshot().version === 0) {
		await rebuildActionDefinitions(actions);
	}
	const authority = createInstanceAuthority(options.instance, options.token);
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
	// The receivers' spans are indexed where they are decoded, so an agent can
	// query the traces its own runs produced (`otel_query`). The index exists only
	// when this process owns the receivers: without a listener there is nothing to
	// index, and the route says so instead of answering an empty list.
	const traceIndex =
		options.receivers && options.signalSink ? new TraceIndex() : undefined;
	const hub = options.hub ?? startWorkflowEventHub(events);
	const operations = options.operations ?? serverOperations;
	// The workflow event catalog (add-orchestrator-event-subscriptions): the
	// server derives catalog events from the same `workflow.updated` stream the
	// refresh hub publishes, so nothing here is a second source of truth. The
	// master switch is read lazily, so an edit applies without a restart.
	const eventBus =
		options.eventBus ??
		createWorkflowEventBus({
			events,
			// Timed for the diagnostics log: these are the synchronous store reads
			// every reconcile tick and every debounced repository refresh pays, and
			// the first thing to suspect when the process blocks.
			view: (repo, workflowId) =>
				diagnosticsSection("store.view", () =>
					operations.view(repo, workflowId),
				),
			listViews: (repo) =>
				diagnosticsSection("store.listViews", () => operations.listViews(repo)),
			monitorMode: memoizedAgents(
				orchestratorMonitorMode,
				DEFAULT_ORCHESTRATOR_MONITOR,
			),
			stallMinutes: memoizedAgents(
				orchestratorStallMinutes,
				DEFAULT_ORCHESTRATOR_STALL_MINUTES,
			),
			// Seconds in the configuration, milliseconds on the bus's own clock.
			reconcileMs: memoizedAgents(
				(agents) => orchestratorReconcileSeconds(agents) * 1_000,
				DEFAULT_ORCHESTRATOR_RECONCILE_SECONDS * 1_000,
			),
			// The per-workflow event budget and its window: the bus's storm guard.
			// The bus reads both once, at construction, so the value is resolved
			// here; a configuration edit applies at the next start. Passing the
			// memoized getter itself left the guard comparing a count against a
			// function - never true, so every window was fresh and the guard never
			// fired (and the wiring did not type-check).
			maxEventsPerWindow: memoizedAgents(
				orchestratorEventBurstLimit,
				DEFAULT_ORCHESTRATOR_EVENT_BURST_LIMIT,
			)(),
			eventWindowMs: memoizedAgents(
				(agents) => orchestratorEventBurstWindowSeconds(agents) * 1_000,
				DEFAULT_ORCHESTRATOR_EVENT_BURST_WINDOW_SECONDS * 1_000,
			)(),
			enrich: (input) => enrichWorkflowEvent(input),
			...(options.configDir
				? { runtimeDir: orchestratorRuntimeDir(options.configDir) }
				: {}),
		});
	const ownedEventBus = options.eventBus ? undefined : eventBus;
	// Slot waits and grants are dashboard envelopes: the broker they publish on
	// exists here, after the integration services were built.
	options.integrations?.attachDashboardEvents?.((event) => {
		events.publish(event);
	});
	// The idle lifecycle is server-scoped: one reaper for this server's whole
	// lifetime, stopped with it. It reads the configured TTL on every pass, so an
	// edit applies without a restart.
	const stopIdleReaper = options.integrations?.instances?.startIdleReaper();
	const app = createServerApp({
		authority,
		events,
		credentials,
		hub,
		...((options.homeDir ?? options.configDir)
			? {
					...(options.homeDir ? { homeDir: options.homeDir } : {}),
					...(options.configDir ? { configDir: options.configDir } : {}),
				}
			: {}),
		...(telemetry ? { telemetry } : {}),
		...(traceIndex ? { traceIndex } : {}),
		...(options.environment ? { environment: options.environment } : {}),
		...(options.version ? { version: options.version } : {}),
		...(options.operations ? { operations: options.operations } : {}),
		...(options.integrations ? { integrations: options.integrations } : {}),
		eventBus,
	});
	const listener = Bun.serve({
		hostname: options.hostname ?? "127.0.0.1",
		port: options.port ?? 0,
		// Event-stream and long-running workflow requests can be quiet for more
		// than Bun's ten-second default. Without this, Bun logs a timeout directly
		// into the TUI instead of letting clients handle the closed request.
		idleTimeout: 0,
		fetch: (request) => app.fetch(request),
	});
	const ownedReceivers: OwnedTelemetryReceivers | undefined =
		options.receivers && options.signalSink
			? await startTelemetryReceivers(
					options.receivers,
					traceIndex
						? {
								...options.signalSink,
								// One push feeds both views: the shell's live stores and the index
								// `otel_query` reads, so neither can miss a span the other has.
								pushTraces: (spans) => {
									traceIndex.push(spans);
									options.signalSink?.pushTraces(spans);
								},
							}
						: options.signalSink,
				)
			: undefined;
	const assignedPort = listener.port ?? options.port ?? 0;
	// The UI spawns the local classifier sidecar at startup whenever that
	// provider is selected, and the sidecar then keeps running independently of
	// this server: panes outlive the engine, so an endpoint they were handed has
	// to survive it. Shutdown deliberately does not stop it, and a provider
	// switch does not either — the service stays warm for the panes that already
	// hold its endpoint. Never blocks startup and never acquires: only an
	// explicit install downloads the model.
	const selectedClassifier = selectedClassifierProvider();
	if (selectedClassifier === LAYA_LOCAL_PROVIDER)
		void startSelectedLocalClassifier(selectedClassifier);
	const url = `http://${listener.hostname}:${assignedPort}`;
	const tokenFile = instanceTokenFile(assignedPort);
	publishInstanceToken(tokenFile, authority.token);
	// Every durable run of this server's workflows gets its own owner-scoped
	// environment capability derived from this endpoint and token.
	publishEnvironmentServer({ url, token: authority.token });
	// The same endpoint is published under the configuration root, so a process
	// that is *not* this server — the workflow CLI's drain, the per-repository
	// agent host, a workflow of another repository — discovers it and derives the
	// same capability for the runs it launches
	// (fix-env-tools-for-all-runs). Two conditions stay tight: only a server that
	// was told which configuration root it serves publishes one (a fixture server
	// must not write into a configuration it does not own), and only one whose
	// agent environment surface can actually answer does — a server without the
	// environment authority or the slot controller would otherwise be discovered
	// and give every run a capability whose every call fails.
	const discoveryConfigDir =
		options.configDir && options.environment && options.integrations?.instances
			? options.configDir
			: undefined;
	if (discoveryConfigDir)
		publishEnvironmentDiscovery(discoveryConfigDir, {
			url,
			token: authority.token,
			instance: authority.instance,
			pid: process.pid,
		});
	let stopped = false;
	return {
		url,
		port: assignedPort,
		instance: authority.instance,
		token: authority.token,
		app,
		operations: app.operations,
		...(app.telemetry ? { telemetry: app.telemetry } : {}),
		stop: async () => {
			if (stopped) return;
			stopped = true;
			clearEnvironmentServer(authority.token);
			if (discoveryConfigDir)
				removeEnvironmentDiscovery(discoveryConfigDir, authority.token);
			stopIdleReaper?.();
			credentials.cancelAll();
			events.closeAll();
			hub.stop();
			ownedEventBus?.stop();
			removeInstanceToken(tokenFile, authority.token);
			await ownedReceivers?.stop();
			ownedTelemetry?.close();
			await listener.stop(true);
		},
	};
}
